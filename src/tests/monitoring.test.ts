import http from 'http';
import { metricsCollector } from '../services/metricsCollector';
import { serviceRegistry } from '../services/serviceRegistry';
import { incidentManager } from '../services/incidentManager';
import { culpritFinder } from '../services/culpritFinder';
import { CONFIG } from '../config';

// Force real mode (no simulated fallbacks) for tests
CONFIG.DEMO_MODE = false;
CONFIG.SCRAPE_TIMEOUT_MS = 600;
CONFIG.HEALTH_CHECK_TIMEOUT_MS = 600;

interface MockServiceConfig {
  port: number;
  healthStatus?: number;
  healthDelayMs?: number;
  metricsStatus?: number;
  metricsBody?: string;
  metricsDelayMs?: number;
}

function startMockHttpService(config: MockServiceConfig): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        const delay = config.healthDelayMs || 0;
        setTimeout(() => {
          res.writeHead(config.healthStatus || 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: config.healthStatus === 200 ? 'UP' : 'ERROR' }));
        }, delay);
        return;
      }

      if (req.url === '/metrics') {
        const delay = config.metricsDelayMs || 0;
        setTimeout(() => {
          res.writeHead(config.metricsStatus || 200, { 'Content-Type': 'text/plain' });
          res.end(config.metricsBody || '');
        }, delay);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(config.port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

export async function runMonitoringTests() {
  console.log('======================================================');
  console.log('   STARTING REAL MONITORING READINESS TEST SUITE      ');
  console.log('======================================================\n');

  // Test 1: Healthy Service
  console.log('--- Test 1: Healthy Service Verification ---');
  const healthyPromMetrics = `
# HELP http_requests_total Total HTTP Requests
http_requests_total{service="mock-healthy",status="200"} 980
http_requests_total{service="mock-healthy",status="500"} 2
# HELP http_request_duration_ms_p95 p95 latency
http_request_duration_ms_p95{service="mock-healthy"} 42
process_resident_memory_bytes{service="mock-healthy"} 85000000
up{service="mock-healthy"} 1
`;
  const healthyServer = await startMockHttpService({
    port: 9101,
    healthStatus: 200,
    metricsStatus: 200,
    metricsBody: healthyPromMetrics
  });

  const healthyResult = await metricsCollector.scrapeService(
    'test-healthy', 
    'http://127.0.0.1:9101/metrics', 
    'http://127.0.0.1:9101/health'
  );

  assert(healthyResult.isReachable === true, 'Healthy service is reachable');
  assert(healthyResult.stats.metricsAvailable === true, 'Metrics parsed successfully');
  assert(healthyResult.stats.errorRate5xx !== null && healthyResult.stats.errorRate5xx < 0.01, `Error rate is low (${healthyResult.stats.errorRate5xx})`);
  assert(healthyResult.stats.p95LatencyMs === 42, `p95 Latency matches Prometheus metric (${healthyResult.stats.p95LatencyMs}ms)`);
  healthyServer.close();

  // Test 2: Unhealthy Service (5xx Error Spike)
  console.log('\n--- Test 2: Unhealthy Service (High 5xx Spike) ---');
  const unhealthyPromMetrics = `
http_requests_total{service="mock-unhealthy",status="200"} 700
http_requests_total{service="mock-unhealthy",status="500"} 300
http_request_duration_ms_p95{service="mock-unhealthy"} 890
`;
  const unhealthyServer = await startMockHttpService({
    port: 9102,
    healthStatus: 200,
    metricsStatus: 200,
    metricsBody: unhealthyPromMetrics
  });

  const unhealthyResult = await metricsCollector.scrapeService(
    'test-unhealthy', 
    'http://127.0.0.1:9102/metrics', 
    'http://127.0.0.1:9102/health'
  );

  assert(unhealthyResult.isReachable === true, 'Unhealthy service is reachable over network');
  assert(unhealthyResult.stats.errorRate5xx === 0.3, `Error rate calculated accurately as 30% (${(unhealthyResult.stats.errorRate5xx ?? 0) * 100}%)`);
  assert(unhealthyResult.stats.p95LatencyMs === 890, 'High p95 latency captured accurately (890ms)');
  unhealthyServer.close();

  // Test 3: Unhealthy Service (Failed Health Check HTTP 503)
  console.log('\n--- Test 3: Failed Health Check (HTTP 503) ---');
  const failingHealthServer = await startMockHttpService({
    port: 9103,
    healthStatus: 503
  });

  const healthFailResult = await metricsCollector.scrapeService(
    'test-health-fail', 
    'http://127.0.0.1:9103/metrics', 
    'http://127.0.0.1:9103/health'
  );

  assert(healthFailResult.isReachable === false, 'Service marked unreachable due to 503 health check');
  assert(healthFailResult.stats.metricsAvailable === false, 'Metrics marked unavailable');
  assert(healthFailResult.errorMessage?.includes('503') === true, 'Error message captures HTTP 503');
  failingHealthServer.close();

  // Test 4: Timeout Service Scenario
  console.log('\n--- Test 4: Timeout Detection (Delayed Response) ---');
  const timeoutServer = await startMockHttpService({
    port: 9104,
    healthDelayMs: 1200 // Exceeds CONFIG.HEALTH_CHECK_TIMEOUT_MS (600ms)
  });

  const timeoutResult = await metricsCollector.scrapeService(
    'test-timeout', 
    'http://127.0.0.1:9104/metrics', 
    'http://127.0.0.1:9104/health'
  );

  assert(timeoutResult.isReachable === false, 'Timed-out service identified as unreachable');
  assert(timeoutResult.errorMessage?.includes('timed out') === true, `Timeout explicitly recorded in error message: ${timeoutResult.errorMessage}`);
  timeoutServer.close();

  // Test 5: Unavailable Metrics Scenario (404 Not Found & Connection Refused)
  console.log('\n--- Test 5: Unavailable Metrics & Connection Refused ---');
  // Port 9199 has no listener
  const connRefusedResult = await metricsCollector.scrapeService(
    'test-down', 
    'http://127.0.0.1:9199/metrics', 
    'http://127.0.0.1:9199/health'
  );

  assert(connRefusedResult.isReachable === false, 'Connection refused correctly identified as unreachable');
  assert(connRefusedResult.stats.metricsAvailable === false, 'metricsAvailable is explicitly false');
  assert(connRefusedResult.errorMessage?.includes('Connection refused') === true, `Connection refused error recorded: ${connRefusedResult.errorMessage}`);
  assert(connRefusedResult.stats.errorRate5xx === null, 'Unreachable service sets errorRate5xx to null (unknown/unavailable, not fabricated 1.0)');

  // Test 6: Deduplication Check (No Duplicate Incidents on Repeated Failures)
  console.log('\n--- Test 6: Incident Deduplication on Repeated Failures ---');
  const testServiceId = 'dedup-test-service';
  serviceRegistry.register({
    id: testServiceId,
    name: 'Dedup Test Service',
    repo: 'app/dedup-test',
    metricsUrl: 'http://127.0.0.1:9199/metrics',
    healthUrl: 'http://127.0.0.1:9199/health',
    containerName: 'dedup-test-1',
    status: 'HEALTHY',
    currentVersion: 'v1.0.0',
    currentStats: { errorRate5xx: 0, p95LatencyMs: 20, throughputRpm: 100, memoryUsagePercent: 30, cpuPercent: 10 }
  });

  const rule = 'Connection Refused: Target is offline';
  const { category, evidence } = culpritFinder.findCulprit(testServiceId, rule);

  // Trigger alarm 5 consecutive times
  const inc1 = incidentManager.createIncident(testServiceId, rule, category, evidence);
  const inc2 = incidentManager.createIncident(testServiceId, rule, category, evidence);
  const inc3 = incidentManager.createIncident(testServiceId, rule, category, evidence);

  assert(inc1.id === inc2.id, `Incident 1 (${inc1.id}) matches Incident 2 (${inc2.id})`);
  assert(inc2.id === inc3.id, `Incident 2 (${inc2.id}) matches Incident 3 (${inc3.id})`);
  
  const allIncidentsForService = incidentManager.getAll().filter(i => i.serviceId === testServiceId);
  assert(allIncidentsForService.length === 1, `Exactly 1 incident recorded despite 3 consecutive alarms (found: ${allIncidentsForService.length})`);
  assert(inc1.actionsTaken.length >= 2, 'Suppressed repeated alarms are recorded inside the active incident actions history');

  console.log('\n======================================================');
  console.log('   ALL 6 MONITORING READINESS TESTS PASSED!          ');
  console.log('======================================================\n');
}

if (require.main === module) {
  runMonitoringTests().catch((err) => {
    console.error('\n❌ Test Suite Aborted with Error:', err);
    process.exit(1);
  });
}
