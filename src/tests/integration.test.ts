import http from 'http';
import express from 'express';
import { WebSocket } from 'ws';
import axios from 'axios';
import { CONFIG } from '../config';
import { serviceRegistry } from '../services/serviceRegistry';
import { metricsCollector } from '../services/metricsCollector';
import { incidentManager } from '../services/incidentManager';
import { culpritFinder } from '../services/culpritFinder';
import { brainService } from '../services/brainService';
import { handsService } from '../services/handsService';
import { syntheticProber } from '../services/syntheticProber';
import { verifierService } from '../services/verifierService';
import { wsBroadcaster } from '../api/websocket';
import apiRoutes from '../api/routes';
import { Incident, RecoveryStrategy, ServiceStats, IncidentAction } from '../types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

async function runPhase5IntegrationTests() {
  console.log('======================================================');
  console.log('   PHASE 5: COMPLETE BACKEND INTEGRATION TEST SUITE   ');
  console.log('======================================================\n');

  CONFIG.DEMO_MODE = false;
  CONFIG.SCRAPE_TIMEOUT_MS = 600;
  CONFIG.HEALTH_CHECK_TIMEOUT_MS = 600;
  CONFIG.ENABLE_DOCKER_REMEDIATION = true;
  CONFIG.ENABLE_CIRCUIT_BREAKER = true;
  CONFIG.ENABLE_RETRY_CONTROLS = true;

  // ----------------------------------------------------
  // Test 1: Service Registration & Application Hook-In
  // ----------------------------------------------------
  console.log('--- Test 1: Service Registration & Universal Hook-In ---');
  const registeredService = serviceRegistry.registerOrUpdate({
    id: 'pulseshop-orders',
    name: 'PulseShop Orders Microservice',
    repo: 'pulseshop/orders-service',
    healthUrl: 'http://localhost:4001/health',
    metricsUrl: 'http://localhost:4001/metrics',
    containerName: 'pulseshop-orders',
    dependencies: ['pulseshop-payments'],
    baselineThroughputRpm: 480,
    status: 'HEALTHY',
    currentVersion: 'v1.0.0',
    currentStats: {
      errorRate5xx: 0.0,
      p95LatencyMs: 35,
      throughputRpm: 480,
      memoryUsagePercent: 40,
      cpuPercent: 20
    }
  });

  assert(registeredService.id === 'pulseshop-orders', 'Service registered with exact PulseShop ID');
  assert(registeredService.baselineThroughputRpm === 480, 'Baseline throughput preserved for business drop detection');
  assert(registeredService.dependencies?.[0] === 'pulseshop-payments', 'Dependency topology stored correctly');

  // Universal post-SDLC hook-in
  const hookedApp = syntheticProber.connect({
    name: 'PulseShop Web App',
    type: 'frontend',
    deployedUrl: 'https://pulseshop-demo.vercel.app',
    healthEndpoint: '/api/health',
    repoUrl: 'https://github.com/pulseshop/web'
  });
  assert(hookedApp.name === 'PulseShop Web App', 'Universal app connected successfully');
  assert(hookedApp.webhookUrl.startsWith('/api/webhooks/ingest/'), 'Dedicated ingestion webhook generated');

  // ----------------------------------------------------
  // Test 2: Multi-Format Telemetry Ingestion (Prometheus + JSON + Vector)
  // ----------------------------------------------------
  console.log('\n--- Test 2: Multi-Format Telemetry Ingestion ---');
  // 2a. Prometheus text format
  const promText = `
# HELP http_requests_total Total requests
http_requests_total{status="200"} 950
http_requests_total{status="500"} 50
http_request_duration_ms_p95 180
orders_processed_total 420
process_resident_memory_bytes 104857600
`;
  const parsedProm = metricsCollector.parseTelemetry(promText);
  assert(parsedProm.metricsAvailable === true, 'Prometheus text format parsed successfully');
  assert(parsedProm.errorRate5xx !== null && Math.abs(parsedProm.errorRate5xx - 0.05) < 0.001, `Error rate parsed as 5% (${parsedProm.errorRate5xx})`);
  assert(parsedProm.p95LatencyMs === 180, 'p95 latency parsed as 180ms');
  assert(parsedProm.ordersRpm === 420, 'Prometheus orders_processed_total parsed as ordersRpm (420)');

  // 2b. JSON telemetry format (e.g. custom /api/telemetry or /stats)
  const jsonTelemetry = {
    errorRate5xx: 0.02,
    p95LatencyMs: 85,
    throughputRpm: 600,
    ordersRpm: 250,
    memoryUsagePercent: 45
  };
  const parsedJson = metricsCollector.parseTelemetry(jsonTelemetry);
  assert(parsedJson.metricsAvailable === true, 'JSON telemetry parsed successfully');
  assert(parsedJson.errorRate5xx === 0.02, 'JSON errorRate5xx parsed accurately');
  assert(parsedJson.p95LatencyMs === 85, 'JSON p95LatencyMs parsed accurately');
  assert(parsedJson.ordersRpm === 250, 'JSON ordersRpm parsed accurately');

  // 2c. Prometheus HTTP Query Vector format
  const vectorTelemetry = {
    status: 'success',
    data: {
      resultType: 'vector',
      result: [
        { metric: { __name__: 'http_requests_5xx_rate' }, value: [1700000000, '0.04'] },
        { metric: { __name__: 'http_latency_p95_ms' }, value: [1700000000, '120'] },
        { metric: { __name__: 'orders_per_minute' }, value: [1700000000, '310'] }
      ]
    }
  };
  const parsedVector = metricsCollector.parseTelemetry(vectorTelemetry);
  assert(parsedVector.metricsAvailable === true, 'Prometheus HTTP vector format parsed successfully');
  assert(parsedVector.errorRate5xx === 0.04, 'Vector errorRate5xx parsed accurately');
  assert(parsedVector.p95LatencyMs === 120, 'Vector p95LatencyMs parsed accurately');
  assert(parsedVector.ordersRpm === 310, 'Vector ordersRpm parsed accurately');

  // ----------------------------------------------------
  // Test 3: Unreachable Service Telemetry Accuracy
  // ----------------------------------------------------
  console.log('\n--- Test 3: Unreachable Service Telemetry Accuracy ---');
  // Scrape a port that is guaranteed not listening
  const deadScrape = await metricsCollector.scrapeService(
    'dead-service',
    'http://127.0.0.1:59999/metrics',
    'http://127.0.0.1:59999/health'
  );
  assert(deadScrape.isReachable === false, 'Dead service accurately flagged as unreachable');
  assert(deadScrape.stats.metricsAvailable === false, 'metricsAvailable is explicitly false');
  assert(deadScrape.stats.errorRate5xx === null, 'errorRate5xx is null (never fabricated 0% or 100%)');
  assert(deadScrape.stats.p95LatencyMs === null, 'p95LatencyMs is null');
  assert(deadScrape.stats.errorMessage !== undefined, 'errorMessage details connection failure');

  // ----------------------------------------------------
  // Test 4: High Error Rate & Latency Spike Detection
  // ----------------------------------------------------
  console.log('\n--- Test 4: High Error Rate & Latency Spike Detection ---');
  const mockHighErrorStats: ServiceStats = {
    errorRate5xx: 0.22,
    p95LatencyMs: 1400,
    throughputRpm: 300,
    memoryUsagePercent: 55,
    cpuPercent: 40,
    metricsAvailable: true
  };

  const triggeredAlarm = metricsCollector.checkWatcherRules(mockHighErrorStats, 'DEGRADED', undefined, 'pulseshop-orders') || '';
  assert(triggeredAlarm.includes('5xx error rate exceeded threshold: 22.0%'), `5xx rule triggered: ${triggeredAlarm}`);

  // ----------------------------------------------------
  // Test 5: Silent Order Drop Detection (HTTP 200 OK, Business Throughput Drop)
  // ----------------------------------------------------
  console.log('\n--- Test 5: Silent Order Drop Detection ---');
  // Baseline is 480 RPM; current orders is 10 RPM (98% drop) but HTTP 5xx is 0.0% (healthy 200s!)
  const mockSilentDropStats: ServiceStats = {
    errorRate5xx: 0.0,
    p95LatencyMs: 40,
    throughputRpm: 350,
    ordersRpm: 10,
    memoryUsagePercent: 50,
    cpuPercent: 20,
    metricsAvailable: true
  };

  const silentDropAlarm = metricsCollector.checkWatcherRules(mockSilentDropStats, 'HEALTHY', undefined, 'pulseshop-orders') || '';
  assert(silentDropAlarm.includes('Silent Order Drop'), `Silent Order Drop detected: ${silentDropAlarm}`);
  assert(mockSilentDropStats.businessMetricDrop === true, 'businessMetricDrop flag attached to telemetry');

  // Diagnose silent order drop via brainService
  const { category: silentCat, evidence: silentEv } = culpritFinder.findCulprit('pulseshop-orders', silentDropAlarm);
  const silentIncident = incidentManager.createIncident('pulseshop-orders', silentDropAlarm, silentCat, silentEv);
  const silentDiagnosis = await brainService.diagnose(silentIncident);

  assert(silentDiagnosis.summary.toLowerCase().includes('silent order drop'), 'Diagnosis identifies silent order drop');
  assert(silentDiagnosis.recoveryStrategies.length >= 2, 'Generated multiple competing recovery strategies');
  assert(
    silentDiagnosis.recoveryStrategies.some(s => s.actionType === 'DOCKER_RESTART'),
    'Includes container restart strategy to unstick queue workers'
  );

  // ----------------------------------------------------
  // Test 6: Incident Deduplication
  // ----------------------------------------------------
  console.log('\n--- Test 6: Incident Deduplication ---');
  const countBefore = incidentManager.getAll().length;
  // Trigger same alarm again on pulseshop-orders
  const { isNew: isNewSecond, incident: dedupIncident } = incidentManager.checkNewEvidence(
    'pulseshop-orders',
    silentDropAlarm,
    silentCat,
    silentEv
  );
  assert(isNewSecond === false, 'Duplicate alarm recognized as existing active incident');
  assert(dedupIncident.id === silentIncident.id, 'Mapped to identical existing incident ID');
  assert(incidentManager.getAll().length === countBefore, 'No duplicate incident created');

  // ----------------------------------------------------
  // Test 7: AI Diagnosis & Structured Counterfactual Planning
  // ----------------------------------------------------
  console.log('\n--- Test 7: Structured Output & Counterfactual Planning ---');
  assert(typeof silentDiagnosis.confidence === 'number' && silentDiagnosis.confidence > 0, 'Diagnosis confidence is a valid float');
  assert(Array.isArray(silentDiagnosis.evidence) && silentDiagnosis.evidence.length > 0, 'Evidence list provided');
  assert(typeof silentDiagnosis.blastRadius === 'string', 'Blast radius assessed');
  assert(Array.isArray(silentDiagnosis.counterfactualEvaluations), 'Counterfactual evaluations present');
  assert(silentDiagnosis.counterfactualEvaluations!.length === silentDiagnosis.recoveryStrategies.length, 'Every candidate strategy evaluated');
  
  const firstEval = silentDiagnosis.counterfactualEvaluations![0];
  assert(typeof firstEval.expectedBenefit === 'string', 'Counterfactual expectedBenefit provided');
  assert(typeof firstEval.cascadingRisk === 'string', 'Counterfactual cascadingRisk provided');
  assert(typeof firstEval.reversibility === 'string', 'Counterfactual reversibility provided');

  // ----------------------------------------------------
  // Test 8: Security Allowlist & Destructive Command Interception
  // ----------------------------------------------------
  console.log('\n--- Test 8: Safety Restrictions & Allowlist Enforcement ---');
  const threatsBefore = incidentManager.getScorecard().threatsBlockedBySietch;

  // 8a. Destructive shell injection
  const dangerousIncident: Incident = {
    ...silentIncident,
    id: 'inc-danger-1',
    diagnosis: {
      ...silentDiagnosis,
      safetyTier: 'NEVER_DO',
      suggestedFix: {
        actionType: 'MANUAL_INSTRUCTION',
        description: 'Drop customer database',
        command: 'rm -rf / && drop database orders;'
      }
    }
  };
  const blockedResult = await handsService.handleRemediation(dangerousIncident);
  assert(blockedResult.executed === false, 'Dangerous action blocked from execution');
  assert(incidentManager.getScorecard().threatsBlockedBySietch === threatsBefore + 1, 'Blocked threats metric incremented');

  // 8b. Unlisted Docker container
  const unlistedError = handsService.validateContainerTarget('unauthorized-crypto-miner');
  assert(unlistedError !== null && unlistedError.includes('not in approved allowlist'), 'Unlisted container rejected');

  // 8c. Valid PulseShop container
  const validContainerError = handsService.validateContainerTarget('pulseshop-orders');
  assert(validContainerError === null, 'PulseShop allowlisted container accepted');

  // ----------------------------------------------------
  // Test 9: Autonomous Execution & Human Operator Approval
  // ----------------------------------------------------
  console.log('\n--- Test 9: Execution & Human Approval Authorization ---');
  let mockExecCalls: string[] = [];
  handsService.setDockerExecutor(async (cmd, args) => {
    mockExecCalls.push(`${cmd} ${args.join(' ')}`);
    return { stdout: 'pulseshop-orders', stderr: '' };
  });

  // 9a. AUTO_FIX execution
  const autoFixIncident = incidentManager.createIncident('pulseshop-orders', 'Auto fix test', 'RUNTIME_FAULT', { recentLogs: [], metricSnapshots: {} });
  autoFixIncident.diagnosis = {
    ...silentDiagnosis,
    safetyTier: 'AUTO_FIX',
    suggestedFix: {
      actionType: 'DOCKER_RESTART',
      description: 'Restart container for pulseshop-orders',
      command: 'docker restart pulseshop-orders'
    }
  };

  const autoExecResult = await handsService.handleRemediation(autoFixIncident);
  assert(autoExecResult.executed === true, 'AUTO_FIX executed autonomously');
  assert(mockExecCalls.includes('docker restart pulseshop-orders'), 'Restricted Docker executor called');

  // 9b. ASK_FIRST requires approval
  const askFirstIncident = incidentManager.createIncident('pulseshop-orders', 'Ask first test', 'RUNTIME_FAULT', { recentLogs: [], metricSnapshots: {} });
  askFirstIncident.diagnosis = {
    ...silentDiagnosis,
    safetyTier: 'ASK_FIRST',
    suggestedFix: {
      actionType: 'SCALE_SERVICE',
      description: 'Scale memory limit to 1024MB',
      command: 'docker update --memory 1024m pulseshop-orders'
    }
  };
  const askResult = await handsService.handleRemediation(askFirstIncident);
  assert(askResult.executed === false, 'ASK_FIRST pauses for operator approval');
  assert(askFirstIncident.status === 'WAITING_APPROVAL', 'Status transitioned to WAITING_APPROVAL');

  // ----------------------------------------------------
  // Test 10: Recovery Failure Preservation
  // ----------------------------------------------------
  console.log('\n--- Test 10: Recovery Failure Preservation ---');
  handsService.setDockerExecutor(async () => {
    throw new Error('Docker daemon connection timed out');
  });

  const failingIncident = incidentManager.createIncident('pulseshop-orders', 'Docker fail test', 'RUNTIME_FAULT', { recentLogs: [], metricSnapshots: {} });
  failingIncident.diagnosis = {
    ...silentDiagnosis,
    safetyTier: 'AUTO_FIX',
    suggestedFix: {
      actionType: 'DOCKER_RESTART',
      description: 'Restart container',
      command: 'docker restart pulseshop-orders'
    }
  };

  const failResult = await handsService.handleRemediation(failingIncident);
  assert(failResult.executed === false, 'Failed Docker command reported as not executed');
  assert(failingIncident.status === 'FAILED', 'Incident marked with status FAILED');
  const loggedActions = incidentManager.getById(failingIncident.id)?.actionsTaken || [];
  assert(
    loggedActions.some((a: IncidentAction) => a.result.includes('Docker daemon connection timed out')),
    'Execution failure detail accurately preserved in actions log'
  );

  // Restore working mock executor
  handsService.setDockerExecutor(async (cmd, args) => ({ stdout: 'OK', stderr: '' }));

  // ----------------------------------------------------
  // Test 11: Cascading Failure Containment
  // ----------------------------------------------------
  console.log('\n--- Test 11: Cascading Failure Containment ---');
  // Configure topology: gateway calls orders
  serviceRegistry.registerOrUpdate({
    id: 'pulseshop-gateway',
    name: 'PulseShop API Gateway',
    repo: 'pulseshop/gateway',
    healthUrl: 'http://localhost:4000/health',
    metricsUrl: 'http://localhost:4000/metrics',
    containerName: 'pulseshop-gateway',
    dependencies: ['pulseshop-orders'],
    baselineThroughputRpm: 1200,
    status: 'HEALTHY',
    currentVersion: 'v1.0.0',
    currentStats: {
      errorRate5xx: 0.0,
      p95LatencyMs: 30,
      throughputRpm: 1200,
      memoryUsagePercent: 40,
      cpuPercent: 20
    }
  });

  // Degrade both orders (bottleneck) and gateway (caller experiencing retry storm)
  serviceRegistry.updateStats('pulseshop-orders', {
    errorRate5xx: 0.25,
    p95LatencyMs: 1200,
    throughputRpm: 800,
    memoryUsagePercent: 70,
    cpuPercent: 85
  }, 'DEGRADED');

  serviceRegistry.updateStats('pulseshop-gateway', {
    errorRate5xx: 0.18,
    p95LatencyMs: 950,
    throughputRpm: 1100,
    memoryUsagePercent: 60,
    cpuPercent: 45
  }, 'DEGRADED');

  const cascadingCheck = serviceRegistry.detectCascadingFailure('pulseshop-orders');
  assert(cascadingCheck.isCascading === true, 'Cascading retry storm detected between gateway and orders');

  const cascadingIncident = incidentManager.createIncident(
    'pulseshop-orders',
    'Retry Storm: Upstream pulseshop-gateway retrying overloaded pulseshop-orders',
    'RUNTIME_FAULT',
    {
      recentLogs: ['upstream timeout 504', 'connection pool exhausted: 100/100 connections busy'],
      metricSnapshots: {
        errorRate5xx: 0.25,
        p95LatencyMs: 1200,
        throughputRpm: 800,
        memoryUsagePercent: 70,
        cpuPercent: 85,
        metricsAvailable: true
      }
    }
  );

  const cascadingDiag = await brainService.diagnose(cascadingIncident);
  assert(cascadingDiag.isCascadingFailure === true, 'Diagnosis identifies cascading failure state');
  assert(
    cascadingDiag.suggestedFix.actionType === 'CIRCUIT_BREAKER_TRIP' || cascadingDiag.suggestedFix.actionType === 'REDUCE_RETRIES',
    `Counterfactual planner avoids blind restart, chose: ${cascadingDiag.suggestedFix.actionType}`
  );

  // ----------------------------------------------------
  // Test 12: Missing/Disabled Adapter Handling
  // ----------------------------------------------------
  console.log('\n--- Test 12: Missing/Disabled Adapters Handling ---');
  CONFIG.ENABLE_DOCKER_REMEDIATION = false;
  const disabledIncident = incidentManager.createIncident('pulseshop-orders', 'Disabled test', 'RUNTIME_FAULT', { recentLogs: [], metricSnapshots: {} });
  disabledIncident.diagnosis = {
    ...silentDiagnosis,
    safetyTier: 'AUTO_FIX',
    suggestedFix: {
      actionType: 'DOCKER_RESTART',
      description: 'Restart container',
      command: 'docker restart pulseshop-orders'
    }
  };
  const disabledResult = await handsService.handleRemediation(disabledIncident);
  assert(disabledResult.executed === false, 'Remediation skipped when disabled by config');
  assert(disabledResult.reason === 'REMEDIATION_DISABLED', 'Reason reported as REMEDIATION_DISABLED');
  CONFIG.ENABLE_DOCKER_REMEDIATION = true; // restore

  // ----------------------------------------------------
  // Test 13: End-to-End REST & WebSocket API Compatibility
  // ----------------------------------------------------
  console.log('\n--- Test 13: End-to-End REST & WebSocket API Compatibility ---');
  const testApp = express();
  testApp.use(express.json());
  testApp.get('/health', (req, res) => res.json({ status: 'UP', agent: 'AI SRE' }));
  testApp.use('/api', apiRoutes);

  const testServer = http.createServer(testApp);
  wsBroadcaster.init(testServer);

  const testPort = 5098;
  await new Promise<void>((resolve) => testServer.listen(testPort, '127.0.0.1', resolve));

  try {
    // 13a. GET /health
    const healthRes = await axios.get(`http://127.0.0.1:${testPort}/health`);
    assert(healthRes.data.status === 'UP', 'REST /health returns status UP');

    // 13b. GET /api/services
    const servicesRes = await axios.get(`http://127.0.0.1:${testPort}/api/services`);
    assert(servicesRes.data.success === true && Array.isArray(servicesRes.data.services), 'REST /api/services returns services array');

    // 13c. GET /api/incidents
    const incidentsRes = await axios.get(`http://127.0.0.1:${testPort}/api/incidents`);
    assert(incidentsRes.data.success === true && Array.isArray(incidentsRes.data.incidents), 'REST /api/incidents returns incidents array');

    // 13d. GET /api/scorecard
    const scorecardRes = await axios.get(`http://127.0.0.1:${testPort}/api/scorecard`);
    assert(scorecardRes.data.success === true && typeof scorecardRes.data.scorecard.avgTimeToDiagnosisSeconds === 'number', 'REST /api/scorecard returns valid metrics');

    // 13e. Human Operator Approval endpoint authorization check
    // Create an incident in WAITING_APPROVAL
    const approvalIncident = incidentManager.createIncident('pulseshop-orders', 'Test manual review', 'RUNTIME_FAULT', { recentLogs: [], metricSnapshots: {} });
    approvalIncident.status = 'WAITING_APPROVAL';
    approvalIncident.diagnosis = {
      ...silentDiagnosis,
      safetyTier: 'ASK_FIRST',
      suggestedFix: { actionType: 'DOCKER_RESTART', description: 'Restart' }
    };

    // Attempt approve without token -> 401
    try {
      await axios.post(`http://127.0.0.1:${testPort}/api/incidents/${approvalIncident.id}/approve`);
      assert(false, 'Approval without token should throw 401');
    } catch (err: any) {
      assert(err.response?.status === 401, 'Approval without token rejected with 401 Unauthorized');
    }

    // Attempt approve with valid X-Operator-Token
    const approveRes = await axios.post(
      `http://127.0.0.1:${testPort}/api/incidents/${approvalIncident.id}/approve`,
      {},
      { headers: { 'X-Operator-Token': CONFIG.OPERATOR_APPROVAL_TOKEN } }
    );
    assert(approveRes.data.success === true, 'Approval with valid operator token succeeded');

    // 13f. WebSocket connection & broadcast verification
    const wsClient = new WebSocket(`ws://127.0.0.1:${testPort}/ws`);
    const wsMessages: any[] = [];

    wsClient.on('message', (data) => {
      try {
        wsMessages.push(JSON.parse(data.toString()));
      } catch (e) {}
    });

    await new Promise<void>((resolve, reject) => {
      wsClient.on('open', () => resolve());
      wsClient.on('error', reject);
    });

    // Wait for handshake
    await new Promise((r) => setTimeout(r, 100));
    assert(wsMessages.some(m => m.type === 'CONNECTED'), 'WebSocket received CONNECTED welcome handshake');

    // Test live broadcast
    wsBroadcaster.broadcast('TEST_ALERT', { message: 'Integration test alert' });
    await new Promise((r) => setTimeout(r, 100));
    assert(wsMessages.some(m => m.type === 'TEST_ALERT'), 'WebSocket client received live broadcast event');

    wsClient.close();
  } finally {
    wsBroadcaster.close();
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
  }

  // ----------------------------------------------------
  // Test 14: Configuration Validation & Port Conflict Absence
  // ----------------------------------------------------
  console.log('\n--- Test 14: Configuration Validation & Port Safety ---');
  assert(CONFIG.PORT !== 4000, `AI SRE Backend port (${CONFIG.PORT}) does NOT conflict with PulseShop Gateway (4000)`);
  assert(CONFIG.PORT !== 4001, `AI SRE Backend port does NOT conflict with PulseShop Orders (4001)`);
  assert(CONFIG.PORT !== 4002, `AI SRE Backend port does NOT conflict with PulseShop Payments (4002)`);
  assert(CONFIG.DOCKER_ALLOWED_CONTAINERS.includes('pulseshop-orders'), 'Container allowlist contains pulseshop-orders');
  assert(CONFIG.DOCKER_ALLOWED_CONTAINERS.includes('pulseshop-gateway'), 'Container allowlist contains pulseshop-gateway');
  assert(CONFIG.DOCKER_ALLOWED_CONTAINERS.includes('pulseshop-payments'), 'Container allowlist contains pulseshop-payments');

  console.log('\n======================================================');
  console.log('   🎉 ALL 14 PHASE 5 INTEGRATION TESTS PASSED!        ');
  console.log('======================================================\n');
}

runPhase5IntegrationTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Integration test failed:', err);
    process.exit(1);
  });
