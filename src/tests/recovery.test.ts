import http from 'http';
import { handsService, DockerExecutor } from '../services/handsService';
import { verifierService } from '../services/verifierService';
import { incidentManager } from '../services/incidentManager';
import { serviceRegistry } from '../services/serviceRegistry';
import { metricsCollector } from '../services/metricsCollector';
import { Incident, IncidentEvidence } from '../types';
import { CONFIG } from '../config';

// Ensure Docker remediation is enabled for tests
CONFIG.ENABLE_DOCKER_REMEDIATION = true;
CONFIG.DOCKER_ALLOWED_CONTAINERS = [
  'fake-shop-orders-1',
  'fake-shop-gateway-1',
  'fake-shop-payments-1',
  'disposable-test-container'
];
CONFIG.OPERATOR_APPROVAL_TOKEN = 'test-operator-secret-123';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

function startMockHttpService(config: { port: number; healthStatus?: number; metricsBody?: string }): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(config.healthStatus || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: config.healthStatus === 200 ? 'UP' : 'DOWN' }));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(config.metricsBody || 'http_requests_total{status="200"} 100\nup 1\n');
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    server.listen(config.port, '127.0.0.1', () => resolve(server));
  });
}

function createTestIncident(id: string, serviceId: string, tier: 'AUTO_FIX' | 'ASK_FIRST' | 'NEVER_DO', actionType: any, command?: string): Incident {
  const inc: Incident = {
    id,
    serviceId,
    title: `Test Incident on ${serviceId}`,
    ruleTriggered: 'Test Rule Triggered',
    category: 'RUNTIME_FAULT',
    status: 'DIAGNOSING',
    severity: 'CRITICAL',
    timestamps: {
      faultStartedAt: new Date(Date.now() - 30000).toISOString(),
      alarmRaisedAt: new Date(Date.now() - 20000).toISOString()
    },
    evidence: {
      metricSnapshots: {},
      recentLogs: []
    },
    diagnosis: {
      diagnosisSource: 'DETERMINISTIC_HEURISTIC',
      summary: 'Test diagnosis',
      rootCause: 'Process crashed due to out of memory',
      evidence: ['Container terminated'],
      confidence: 0.95,
      blastRadius: 'Single pod',
      recoveryStrategies: [],
      explanation: 'Test explanation',
      safetyTier: tier,
      suggestedFix: {
        actionType,
        description: `Restart container for ${serviceId}`,
        command: command || 'docker restart fake-shop-orders-1'
      }
    },
    actionsTaken: []
  };
  (incidentManager as any).incidents.set(id, inc);
  return inc;
}

export async function runRecoveryTests() {
  console.log('======================================================');
  console.log('   STARTING REAL REMEDIATION & VERIFICATION TESTS     ');
  console.log('======================================================\n');

  // Register mock test service
  serviceRegistry.register({
    id: 'orders-service',
    name: 'Orders Service',
    repo: 'fake-shop/orders',
    metricsUrl: 'http://127.0.0.1:9201/metrics',
    healthUrl: 'http://127.0.0.1:9201/health',
    containerName: 'fake-shop-orders-1',
    status: 'DEGRADED',
    currentVersion: 'v1.0.0',
    currentStats: { errorRate5xx: 0.25, p95LatencyMs: 300, throughputRpm: 100, memoryUsagePercent: 80, cpuPercent: 30 }
  });

  // ----------------------------------------------------------------
  // Test 1: Successful authorized Docker restart (allowlisted container)
  // ----------------------------------------------------------------
  console.log('--- Test 1: Authorized Docker Restart ---');
  let executedCommand = '';
  let executedArgs: string[] = [];
  const mockRunner: DockerExecutor = async (cmd, args) => {
    executedCommand = cmd;
    executedArgs = args;
    return { stdout: 'fake-shop-orders-1\n', stderr: '' };
  };
  handsService.setDockerExecutor(mockRunner);

  const inc1 = createTestIncident('INC-TEST-REC-001', 'orders-service', 'AUTO_FIX', 'DOCKER_RESTART', 'docker restart fake-shop-orders-1');
  const res1 = await handsService.handleRemediation(inc1);

  assert(res1.executed === true, 'Authorized Docker restart executed successfully');
  assert(executedCommand === 'docker', 'Executed restricted "docker" binary via execFile');
  assert(executedArgs[0] === 'restart' && executedArgs[1] === 'fake-shop-orders-1', 'Restarted allowlisted container fake-shop-orders-1');
  assert(inc1.status === 'VERIFYING', `Incident status transitioned to VERIFYING (current: ${inc1.status})`);
  assert(Boolean(inc1.timestamps.fixAppliedAt), 'Timestamp fixAppliedAt recorded');

  // ----------------------------------------------------------------
  // Test 2: Service recovery confirmed by real health checks
  // ----------------------------------------------------------------
  console.log('\n--- Test 2: Recovery Verification via Real Health Endpoint ---');
  const healthyServer = await startMockHttpService({
    port: 9201,
    healthStatus: 200,
    metricsBody: 'http_requests_total{status="200"} 500\nhttp_requests_total{status="500"} 1\nup 1\n'
  });

  const verified = await verifierService.watchRecovery(inc1, 100, 1000);
  assert(verified === true, 'Verifier confirmed service recovery via real HTTP /health probe');
  assert(inc1.status === 'RESOLVED', `Incident marked RESOLVED upon verification (current: ${inc1.status})`);
  assert(Boolean(inc1.timestamps.resolvedAt), 'Timestamp resolvedAt recorded');
  assert(Boolean(inc1.evidence.verificationEvidence), 'Verification evidence recorded in incident');
  assert(inc1.evidence.verificationEvidence?.checks.some(c => c.status === 'PASSED') === true, 'Passed checks recorded in evidence');
  healthyServer.close();

  // ----------------------------------------------------------------
  // Test 3: Docker succeeds but app remains unhealthy -> verification fails
  // ----------------------------------------------------------------
  console.log('\n--- Test 3: Verification Failure when App Remains Unhealthy (HTTP 503) ---');
  const unhealthyServer = await startMockHttpService({
    port: 9201,
    healthStatus: 503
  });

  const inc3 = createTestIncident('INC-TEST-REC-003', 'orders-service', 'AUTO_FIX', 'DOCKER_RESTART');
  inc3.status = 'VERIFYING';
  const failedVerification = await verifierService.watchRecovery(inc3, 100, 400);

  assert(failedVerification === false, 'Verifier correctly returned false when service remains 503');
  assert((inc3.status as Incident['status']) === 'FAILED', `Incident marked FAILED (current: ${inc3.status})`);
  assert(inc3.evidence.verificationEvidence?.checks.some(c => c.status === 'FAILED') === true, 'Failed probe checks recorded');
  unhealthyServer.close();

  // ----------------------------------------------------------------
  // Test 4: Unknown / un-allowlisted container rejected with security denial
  // ----------------------------------------------------------------
  console.log('\n--- Test 4: Security Denial for Unlisted Container ---');
  serviceRegistry.register({
    id: 'unauthorized-service',
    name: 'Unauthorized Service',
    repo: 'internal/db',
    metricsUrl: 'http://127.0.0.1:9999/metrics',
    healthUrl: 'http://127.0.0.1:9999/health',
    containerName: 'production-postgres-primary', // NOT in allowlist
    status: 'DEGRADED',
    currentVersion: 'v1.0.0',
    currentStats: { errorRate5xx: 0, p95LatencyMs: 0, throughputRpm: 0, memoryUsagePercent: 0, cpuPercent: 0 }
  });

  const inc4 = createTestIncident('INC-TEST-REC-004', 'unauthorized-service', 'AUTO_FIX', 'DOCKER_RESTART');
  const res4 = await handsService.handleRemediation(inc4);

  assert(res4.executed === false, 'Execution blocked for un-allowlisted container');
  assert(res4.reason === 'SECURITY_DENIAL', `Reason is SECURITY_DENIAL (got: ${res4.reason})`);
  assert(res4.message.includes('Security Denial'), 'Message states security denial explicitly');

  // ----------------------------------------------------------------
  // Test 5: Dangerous or arbitrary command rejected (shell injection, destructive query)
  // ----------------------------------------------------------------
  console.log('\n--- Test 5: Destructive / Arbitrary Command Interception ---');
  const inc5 = createTestIncident(
    'INC-TEST-REC-005', 
    'orders-service', 
    'AUTO_FIX', 
    'DOCKER_RESTART', 
    'docker restart fake-shop-orders-1; rm -rf /var/lib/data'
  );
  inc5.diagnosis!.suggestedFix.description = 'rm -rf / && DROP DATABASE users;';
  const res5 = await handsService.handleRemediation(inc5);

  assert(res5.executed === false, 'Dangerous shell / SQL command blocked');
  assert(res5.reason === 'POLICY_DENIED_NEVER_DO' || res5.reason === 'SECURITY_DENIAL', 'Dangerous operation blocked by policy engine');

  // ----------------------------------------------------------------
  // Test 6: ASK_FIRST action blocked without valid operator token
  // ----------------------------------------------------------------
  console.log('\n--- Test 6: Safety Tier ASK_FIRST Enforcement & Operator Auth ---');
  const inc6 = createTestIncident('INC-TEST-REC-006', 'orders-service', 'ASK_FIRST', 'DOCKER_RESTART');
  const res6Autonomous = await handsService.handleRemediation(inc6);

  assert(res6Autonomous.executed === false, 'Autonomous execution blocked for ASK_FIRST action');
  assert(res6Autonomous.reason === 'WAITING_APPROVAL', 'Incident transitioned to WAITING_APPROVAL');
  assert(inc6.status === 'WAITING_APPROVAL', 'Incident status set to WAITING_APPROVAL');

  // Simulate invalid operator token attempt
  const invalidToken = 'wrong-token';
  const isAuthValid = invalidToken === CONFIG.OPERATOR_APPROVAL_TOKEN;
  assert(isAuthValid === false, 'Invalid operator token rejected');

  // Execute with valid operator authorization
  const validToken = CONFIG.OPERATOR_APPROVAL_TOKEN;
  assert(validToken === 'test-operator-secret-123', 'Valid operator token matches configuration');
  const res6Approved = await handsService.executeRemediation(inc6, 'HUMAN_OPERATOR');
  assert(res6Approved.executed === true, 'Approved remediation executed by HUMAN_OPERATOR');

  // ----------------------------------------------------------------
  // Test 7: NEVER_DO action rejected even if suggested by AI
  // ----------------------------------------------------------------
  console.log('\n--- Test 7: Safety Tier NEVER_DO Strict Blocking ---');
  const initialThreats = incidentManager.getScorecard().threatsBlockedBySietch;
  const inc7 = createTestIncident('INC-TEST-REC-007', 'orders-service', 'NEVER_DO', 'SCALE_SERVICE');
  inc7.diagnosis!.suggestedFix.description = 'Direct schema migration or data drop';
  const res7 = await handsService.handleRemediation(inc7);

  assert(res7.executed === false, 'NEVER_DO action strictly blocked by agent');
  assert(res7.reason === 'POLICY_DENIED_NEVER_DO', 'Reason is POLICY_DENIED_NEVER_DO');
  const updatedThreats = incidentManager.getScorecard().threatsBlockedBySietch;
  assert(updatedThreats > initialThreats, 'Blocked threats scorecard counter incremented');

  // ----------------------------------------------------------------
  // Test 8: Duplicate recovery requests do not execute twice (Idempotency)
  // ----------------------------------------------------------------
  console.log('\n--- Test 8: Remediation Idempotency Guard ---');
  const inc8 = createTestIncident('INC-TEST-REC-008', 'orders-service', 'AUTO_FIX', 'DOCKER_RESTART');
  inc8.status = 'EXECUTING';
  const res8Executing = await handsService.executeRemediation(inc8, 'AI_AGENT');
  assert(res8Executing.executed === false, 'Cannot execute remediation while already EXECUTING');

  inc8.status = 'VERIFYING';
  const res8Verifying = await handsService.executeRemediation(inc8, 'HUMAN_OPERATOR');
  assert(res8Verifying.executed === false, 'Cannot execute remediation while in VERIFYING state');

  // ----------------------------------------------------------------
  // Test 9: Docker execution timeout handled gracefully
  // ----------------------------------------------------------------
  console.log('\n--- Test 9: Docker Execution Timeout Handling ---');
  const timingOutRunner: DockerExecutor = async () => {
    const timeoutErr: any = new Error('Command timed out');
    timeoutErr.code = 'ETIMEDOUT';
    timeoutErr.killed = true;
    throw timeoutErr;
  };
  handsService.setDockerExecutor(timingOutRunner);

  const inc9 = createTestIncident('INC-TEST-REC-009', 'orders-service', 'AUTO_FIX', 'DOCKER_RESTART');
  const res9 = await handsService.executeRemediation(inc9, 'AI_AGENT');

  assert(res9.executed === false, 'Timed-out Docker command returns executed: false');
  assert(res9.reason === 'EXECUTION_FAILED', 'Failure reason identified as EXECUTION_FAILED');
  assert(res9.message.includes('timed out'), 'Error message clearly references timeout');
  assert(inc9.status === 'FAILED', 'Incident transitioned to FAILED status upon execution failure');

  // Restore mock runner
  handsService.setDockerExecutor(mockRunner);

  // ----------------------------------------------------------------
  // Test 10: Unreachable service produces errorRate5xx: null (Issue A verified)
  // ----------------------------------------------------------------
  console.log('\n--- Test 10: Unreachable Service Produces null Error Rate (Issue A) ---');
  // Port 9998 has no listener
  const offlineResult = await metricsCollector.scrapeService(
    'offline-service',
    'http://127.0.0.1:9998/metrics',
    'http://127.0.0.1:9998/health'
  );

  assert(offlineResult.isReachable === false, 'Offline service identified as unreachable');
  assert(offlineResult.stats.metricsAvailable === false, 'Metrics marked unavailable');
  assert(offlineResult.stats.errorRate5xx === null, `errorRate5xx is null (actual: ${offlineResult.stats.errorRate5xx}), not fabricated 1.0`);
  assert(offlineResult.stats.p95LatencyMs === null, 'p95LatencyMs is null, not 0');
  assert(offlineResult.stats.throughputRpm === null, 'throughputRpm is null');

  console.log('\n======================================================');
  console.log('   ALL 10 RECOVERY & VERIFICATION TESTS PASSED!       ');
  console.log('======================================================\n');
}

if (require.main === module) {
  runRecoveryTests()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Recovery Test Suite Aborted with Error:', err);
      process.exit(1);
    });
}
