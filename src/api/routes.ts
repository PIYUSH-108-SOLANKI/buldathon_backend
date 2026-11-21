import { Router, Request, Response } from 'express';
import { CONFIG } from '../config';
import { serviceRegistry } from '../services/serviceRegistry';
import { incidentManager } from '../services/incidentManager';
import { logCollector } from '../services/logCollector';
import { culpritFinder } from '../services/culpritFinder';
import { brainService } from '../services/brainService';
import { handsService } from '../services/handsService';
import { webhookService } from '../services/webhookService';
import { syntheticProber } from '../services/syntheticProber';
import { wsBroadcaster } from './websocket';

const router = Router();

// ==========================================
// 1. Services & Application Registry
// ==========================================

router.get('/services', (req: Request, res: Response) => {
  res.json({
    success: true,
    services: serviceRegistry.getAll()
  });
});

router.post('/services', (req: Request, res: Response) => {
  const { id, name, repo, metricsUrl, grafanaUrl, healthUrl, containerName } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: 'id and name are required' });
  }

  const created = serviceRegistry.register({
    id,
    name,
    repo: repo || `fake-shop/${id}`,
    metricsUrl: metricsUrl || `http://localhost:3000/metrics`,
    grafanaUrl,
    healthUrl: healthUrl || `http://localhost:3000/health`,
    containerName: containerName || id,
    status: 'HEALTHY',
    currentVersion: 'v1.0.0',
    currentStats: {
      errorRate5xx: 0.001,
      p95LatencyMs: 35,
      throughputRpm: 100,
      memoryUsagePercent: 30,
      cpuPercent: 10
    }
  });

  wsBroadcaster.broadcast('SERVICE_REGISTERED', created);
  res.status(201).json({ success: true, service: created });
});

// ==========================================
// 1b. Universal Application Hook-In (Post-SDLC Maintenance)
// ==========================================

router.get('/applications', (req: Request, res: Response) => {
  res.json({
    success: true,
    applications: syntheticProber.getAll()
  });
});

router.post('/applications/connect', async (req: Request, res: Response) => {
  const { name, type = 'backend', deployedUrl, healthEndpoint, metricsEndpoint, repoUrl } = req.body;
  if (!name || !deployedUrl) {
    return res.status(400).json({ error: 'name and deployedUrl are required to connect an application' });
  }

  const app = syntheticProber.connect({
    name,
    type,
    deployedUrl,
    healthEndpoint,
    metricsEndpoint,
    repoUrl
  });

  // Run immediate first probe
  await syntheticProber.probe(app);

  res.status(201).json({
    success: true,
    message: `Application '${app.name}' successfully hooked into autonomous maintenance!`,
    application: app,
    setupGuide: {
      dedicatedWebhookUrl: `http://localhost:${CONFIG.PORT}${app.webhookUrl}`,
      token: app.webhookToken,
      instructions: [
        `1. Add 'http://localhost:${CONFIG.PORT}${app.webhookUrl}' to your GitHub / Vercel / Netlify Deploy Webhooks.`,
        `2. For crash monitoring, forward exceptions via POST to 'http://localhost:${CONFIG.PORT}${app.webhookUrl}'.`,
        `3. Synthetic probes are active, pinging '${app.deployedUrl}${app.healthEndpoint}' automatically.`
      ]
    }
  });
});

router.post('/applications/:id/probe', async (req: Request, res: Response) => {
  const appId = req.params.id as string;
  const app = syntheticProber.getById(appId);
  if (!app) return res.status(404).json({ error: 'Application not found' });

  const result = await syntheticProber.probe(app);
  res.json({ success: true, application: app, probeResult: result });
});

router.delete('/applications/:id', (req: Request, res: Response) => {
  const appId = req.params.id as string;
  const deleted = syntheticProber.remove(appId);
  if (!deleted) return res.status(404).json({ error: 'Application not found' });
  res.json({ success: true, message: `Application '${appId}' unhooked from maintenance.` });
});

// Universal Ingestion Webhook for a specific connected application
router.post('/webhooks/ingest/:appId', async (req: Request, res: Response) => {
  const appId = req.params.appId as string;
  try {
    const result = await syntheticProber.handleIngestedWebhook(appId, req.body, req.headers);
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/services/:id/metrics', (req: Request, res: Response) => {
  const serviceId = req.params.id as string;
  const service = serviceRegistry.getById(serviceId);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  res.json({
    success: true,
    serviceId: service.id,
    currentStats: service.currentStats,
    history: service.history
  });
});

router.get('/services/:id/logs', (req: Request, res: Response) => {
  const serviceId = req.params.id as string;
  const service = serviceRegistry.getById(serviceId);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const logs = logCollector.getRecentLogs(service.id);
  res.json({
    success: true,
    serviceId: service.id,
    logs
  });
});

// ==========================================
// 2. Deploy Markers & Webhooks (The Listener)
// ==========================================

// Direct deploy marker endpoint
router.post(['/deploy', '/webhooks/deploy'], (req: Request, res: Response) => {
  const { serviceId, commitSha, commitMessage, author, environment, diffSummary } = req.body;
  if (!serviceId || !commitSha) {
    return res.status(400).json({ error: 'serviceId and commitSha are required' });
  }

  const marker = incidentManager.recordDeployMarker({
    serviceId,
    commitSha,
    commitMessage: commitMessage || 'feat: automated deployment',
    author: author || 'deploy-bot@company.com',
    timestamp: new Date().toISOString(),
    environment: environment || 'production',
    diffSummary
  });

  serviceRegistry.updateVersion(serviceId, `${commitSha.slice(0, 7)} (${commitMessage || 'latest'})`);
  wsBroadcaster.broadcast('DEPLOY_MARKER', marker);

  res.status(201).json({ success: true, marker });
});

// GitHub Webhook Endpoint with HMAC signature check
router.post('/webhooks/github', (req: Request, res: Response) => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const rawPayload = JSON.stringify(req.body);

  if (!webhookService.verifyGitHubSignature(rawPayload, signature)) {
    return res.status(401).json({ error: 'Invalid GitHub webhook signature' });
  }

  const event = (req.headers['x-github-event'] as string) || 'push';
  const result = webhookService.handleGitHubEvent(event, req.body);

  res.json({ success: true, result });
});

// Prometheus Alertmanager Webhook Endpoint
router.post('/webhooks/alertmanager', async (req: Request, res: Response) => {
  try {
    const result = await webhookService.handleAlertmanagerAlert(req.body);
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Grafana Unified Alerting Webhook Endpoint
router.post('/webhooks/grafana', async (req: Request, res: Response) => {
  try {
    const result = await webhookService.handleGrafanaAlert(req.body);
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Direct Application Logs & Exception Webhook (For your friend's microservices)
router.post(['/logs', '/webhooks/logs'], (req: Request, res: Response) => {
  const { serviceId, message, error, stack, level = 'ERROR' } = req.body;
  if (!serviceId) {
    return res.status(400).json({ error: 'serviceId is required' });
  }

  const logLine = `[${level}] ${message || error || 'Application Error'}${stack ? '\n' + stack : ''}`;
  logCollector.appendLog(serviceId, logLine);

  // If error with stack trace, automatically trigger culprit analysis and AI Brain
  if (level.toUpperCase() === 'ERROR' || level.toUpperCase() === 'FATAL' || stack) {
    const rule = `Application Exception: ${message || error || 'Unhandled Error'}`;
    const { category, evidence } = culpritFinder.findCulprit(serviceId, rule);
    
    if (stack) {
      evidence.stackTrace = stack;
    }

    const { incident, isNew, requiresReassessment } = incidentManager.checkNewEvidence(serviceId, rule, category, evidence);

    if (isNew || requiresReassessment) {
      if (isNew) {
        wsBroadcaster.broadcast('INCIDENT_DETECTED', incident);
      }

      setTimeout(async () => {
        const diagnosis = await brainService.diagnose(incident);
        incidentManager.setDiagnosis(incident.id, diagnosis);
        wsBroadcaster.broadcast('INCIDENT_DIAGNOSED', incidentManager.getById(incident.id));
        await handsService.handleRemediation(incident);
        wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
      }, 1000);
    }
  }

  res.status(201).json({ success: true, message: 'Log ingested and processed' });
});

// ==========================================
// 3. Incidents, Evidence & Approvals
// ==========================================

router.get('/incidents', (req: Request, res: Response) => {
  res.json({
    success: true,
    incidents: incidentManager.getAll()
  });
});

router.get('/incidents/:id', (req: Request, res: Response) => {
  const incidentId = req.params.id as string;
  const incident = incidentManager.getById(incidentId);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });
  res.json({ success: true, incident });
});

router.post('/incidents/:id/approve', async (req: Request, res: Response) => {
  const incidentId = req.params.id as string;
  const incident = incidentManager.getById(incidentId);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  // 1. Authenticate Operator Token
  const tokenHeader = req.headers['x-operator-token'] as string | undefined;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
  const providedToken = tokenHeader || bearerToken;

  if (!providedToken || providedToken !== CONFIG.OPERATOR_APPROVAL_TOKEN) {
    return res.status(401).json({ 
      error: 'Unauthorized: Invalid or missing operator approval token. Provide X-Operator-Token header or Bearer authorization.' 
    });
  }

  // 2. Idempotency and State Validation
  if (incident.status === 'EXECUTING' || incident.status === 'VERIFYING') {
    return res.status(400).json({ error: `Incident is currently in '${incident.status}' state. Recovery cannot be triggered multiple times.` });
  }

  if (incident.status === 'RESOLVED') {
    return res.status(400).json({ error: 'Incident is already RESOLVED. Recovery has completed.' });
  }

  if (incident.status !== 'WAITING_APPROVAL') {
    return res.status(400).json({ error: `Incident is in status '${incident.status}', not waiting for approval.` });
  }

  // 3. Transition to EXECUTING and execute remediation with HUMAN_OPERATOR identity
  incidentManager.updateStatus(incident.id, 'EXECUTING');
  const result = await handsService.executeRemediation(incident, 'HUMAN_OPERATOR');

  wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
  res.json({ success: true, message: 'Action approved and executed by operator', result });
});

// ==========================================
// 4. Scorecard & Postmortems
// ==========================================

router.get('/scorecard', (req: Request, res: Response) => {
  res.json({
    success: true,
    scorecard: incidentManager.getScorecard()
  });
});

router.get('/postmortems', (req: Request, res: Response) => {
  const incidents = incidentManager.getAll().filter(i => !!i.postmortem);
  res.json({
    success: true,
    postmortems: incidents.map(i => ({
      incidentId: i.id,
      serviceId: i.serviceId,
      resolvedAt: i.timestamps.resolvedAt,
      timeToDiagnosisSeconds: i.timestamps.timeToDiagnosisSeconds,
      timeToRecoverySeconds: i.timestamps.timeToRecoverySeconds,
      content: i.postmortem
    }))
  });
});

// ==========================================
// 5. Sietch Sandbox Integration
// ==========================================

router.post(['/sietch/check', '/webhooks/sietch'], (req: Request, res: Response) => {
  const { packageName, version, passed, threatType, traceLogs } = req.body;

  if (!passed) {
    incidentManager.incrementBlockedThreats();
    logCollector.appendLog('orders-service', `[SIETCH SECURITY SHIELD] BLOCKED package ${packageName}@${version}: Threat detected (${threatType || 'Credential Harvesting'})`);
    wsBroadcaster.broadcast('SIETCH_ALERT', { packageName, version, passed: false, threatType, traceLogs });
  } else {
    logCollector.appendLog('orders-service', `[SIETCH] Verified safe package ${packageName}@${version}`);
  }

  res.json({ success: true, status: passed ? 'PASSED' : 'BLOCKED' });
});

// ==========================================
// 6. Fault Simulation & Demo Control
// ==========================================

router.post('/incidents/simulate', async (req: Request, res: Response) => {
  const { scenario, serviceId = 'orders-service' } = req.body;
  const validScenarios = ['bug_checkout', 'slow_query', 'killed_service', 'bad_package', 'memory_leak'];

  if (!validScenarios.includes(scenario)) {
    return res.status(400).json({ error: `Invalid scenario. Choose from: ${validScenarios.join(', ')}` });
  }

  // 1. Inject fault logs & stack traces
  const stack = logCollector.injectFaultLogs(serviceId, scenario);

  // 2. Adjust telemetry stats to reflect failure
  if (scenario === 'bug_checkout') {
    serviceRegistry.updateStats(serviceId, {
      errorRate5xx: 0.165,
      p95LatencyMs: 190,
      throughputRpm: 120,
      memoryUsagePercent: 50,
      cpuPercent: 32
    }, 'DEGRADED');
  } else if (scenario === 'slow_query') {
    serviceRegistry.updateStats(serviceId, {
      errorRate5xx: 0.08,
      p95LatencyMs: 2400,
      throughputRpm: 80,
      memoryUsagePercent: 62,
      cpuPercent: 78
    }, 'DEGRADED');
  } else if (scenario === 'killed_service') {
    serviceRegistry.updateStats(serviceId, {
      errorRate5xx: 1.0,
      p95LatencyMs: 0,
      throughputRpm: 0,
      memoryUsagePercent: 0,
      cpuPercent: 0
    }, 'DOWN');
  } else if (scenario === 'memory_leak') {
    serviceRegistry.updateStats(serviceId, {
      errorRate5xx: 0.04,
      p95LatencyMs: 650,
      throughputRpm: 210,
      memoryUsagePercent: 96.8,
      cpuPercent: 88
    }, 'WARNING');
  }

  // 3. Trigger Culprit Finder
  const rule = scenario === 'killed_service' 
    ? 'Service down: Container health check failed' 
    : scenario === 'slow_query'
    ? 'p95 response time spike: 2400ms > 400ms'
    : '5xx error rate exceeded threshold: 16.5%';

  const { category, evidence } = culpritFinder.findCulprit(serviceId, rule);

  // 4. Create Incident (T1)
  const incident = incidentManager.createIncident(serviceId, rule, category, evidence);
  wsBroadcaster.broadcast('INCIDENT_DETECTED', incident);

  // 5. Asynchronously diagnose via The Brain
  setTimeout(async () => {
    const diagnosis = await brainService.diagnose(incident);
    incidentManager.setDiagnosis(incident.id, diagnosis);
    wsBroadcaster.broadcast('INCIDENT_DIAGNOSED', incidentManager.getById(incident.id));

    // 6. Enforce safety tiers
    await handsService.handleRemediation(incident);
    wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
  }, 1200);

  res.json({
    success: true,
    message: `Scenario '${scenario}' simulated successfully. Incident ${incident.id} triggered.`,
    incidentId: incident.id
  });
});

router.post('/incidents/reset', (req: Request, res: Response) => {
  // Put all services back into HEALTHY state
  for (const s of serviceRegistry.getAll()) {
    serviceRegistry.updateStats(s.id, {
      errorRate5xx: 0.002,
      p95LatencyMs: 45,
      throughputRpm: 450,
      memoryUsagePercent: 40,
      cpuPercent: 15
    }, 'HEALTHY');
  }

  logCollector.appendLog('gateway-service', '[Demo Reset] System reset to clean baseline healthy state.');
  wsBroadcaster.broadcast('SYSTEM_RESET', { status: 'HEALTHY' });

  res.json({ success: true, message: 'All services reset to HEALTHY baseline.' });
});

export default router;
