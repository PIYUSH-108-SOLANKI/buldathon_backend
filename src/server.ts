import http from 'http';
import express from 'express';
import cors from 'cors';
import { CONFIG } from './config';
import routes from './api/routes';
import { wsBroadcaster } from './api/websocket';
import { metricsCollector } from './services/metricsCollector';
import { culpritFinder } from './services/culpritFinder';
import { incidentManager } from './services/incidentManager';
import { brainService } from './services/brainService';
import { handsService } from './services/handsService';
import { syntheticProber } from './services/syntheticProber';

const app = express();
const server = http.createServer(app);

// Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Healthcheck
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    agent: 'AI Site-Reliability Agent Backend (AIA-02)',
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.use('/api', routes);

// Initialize WebSocket Broadcaster
wsBroadcaster.init(server);

// Start Telemetry Watcher Loop (Plain rules, every 5s)
metricsCollector.start(async (serviceId, ruleTriggered, stats) => {
  // 1. Culprit Finder isolates evidence
  const { category, evidence } = culpritFinder.findCulprit(serviceId, ruleTriggered);

  // 2. Check for meaningful new evidence or existing incident (prevents duplicate spam while allowing reassessment)
  const { incident, isNew, requiresReassessment } = incidentManager.checkNewEvidence(
    serviceId, 
    ruleTriggered, 
    category, 
    evidence
  );

  if (!isNew && !requiresReassessment) {
    return;
  }

  console.log(`[Watcher Alarm] ${isNew ? 'New incident detected' : 'Meaningful new evidence detected'} on ${serviceId}: ${ruleTriggered}`);

  if (isNew) {
    wsBroadcaster.broadcast('INCIDENT_DETECTED', incident);
  }

  // 3. Brain diagnoses root cause asynchronously (T2 timestamp)
  const diagnosis = await brainService.diagnose(incident);
  incidentManager.setDiagnosis(incident.id, diagnosis);
  wsBroadcaster.broadcast('INCIDENT_DIAGNOSED', incidentManager.getById(incident.id));

  // 4. Hands applies remediation according to Safety Tiers
  await handsService.handleRemediation(incident);
  wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
});

// Start Synthetic Probing Loop for Connected Deployed Links (Every 15s)
syntheticProber.startProbingLoop(15000);

// Start Server
server.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`
======================================================
  SRE AGENT + SIETCH BACKEND (AIA-02) RUNNING
======================================================
  Port:              http://localhost:${CONFIG.PORT}
  REST API:          http://localhost:${CONFIG.PORT}/api
  WebSocket:         ws://localhost:${CONFIG.PORT}/ws
  Healthcheck:       http://localhost:${CONFIG.PORT}/health
======================================================
  Key Endpoints for Teammates:
  - Services:        GET  /api/services
  - Metrics:         GET  /api/services/:id/metrics
  - Logs:            GET  /api/services/:id/logs
  - Deploy Marker:   POST /api/deploy
  - Incidents:       GET  /api/incidents
  - Approve Action:  POST /api/incidents/:id/approve
  - Scorecard:       GET  /api/scorecard
  - Postmortems:     GET  /api/postmortems
  - Simulate Fault:  POST /api/incidents/simulate
  - Demo Reset:      POST /api/incidents/reset
======================================================
`);
});
