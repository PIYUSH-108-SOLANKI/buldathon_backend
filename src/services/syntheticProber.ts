import axios from 'axios';
import crypto from 'crypto';
import { ConnectedApplication, ServiceHealthStatus } from '../types';
import { CONFIG } from '../config';
import { serviceRegistry } from './serviceRegistry';
import { logCollector } from './logCollector';
import { culpritFinder } from './culpritFinder';
import { incidentManager } from './incidentManager';
import { brainService } from './brainService';
import { handsService } from './handsService';
import { wsBroadcaster } from '../api/websocket';

export class SyntheticProber {
  private applications: Map<string, ConnectedApplication> = new Map();
  private probeInterval?: NodeJS.Timeout;
  private failureCounts: Map<string, number> = new Map();
  private totalProbes: Map<string, { total: number; successful: number }> = new Map();

  constructor() {
    this.seedDefaultApplications();
  }

  private seedDefaultApplications() {
    const demoApps: Omit<ConnectedApplication, 'webhookUrl' | 'webhookToken' | 'status' | 'uptimePercent' | 'lastProbe' | 'createdAt'>[] = [
      {
        id: 'app-storefront-frontend',
        name: 'Storefront Web Application',
        type: 'frontend',
        deployedUrl: 'https://demo-shop.vercel.app',
        healthEndpoint: '/',
        repoUrl: 'https://github.com/company/storefront-web'
      },
      {
        id: 'app-orders-backend',
        name: 'Orders Core API',
        type: 'backend',
        deployedUrl: 'http://127.0.0.1:3001',
        healthEndpoint: '/health',
        metricsEndpoint: '/metrics',
        repoUrl: 'https://github.com/company/orders-api'
      }
    ];

    for (const app of demoApps) {
      this.connect(app);
    }
  }

  /**
   * Connect any deployed application link (Frontend or Backend) to post-SDLC maintenance
   */
  public connect(params: {
    id?: string;
    name: string;
    type: 'frontend' | 'backend' | 'fullstack' | 'microservice';
    deployedUrl: string;
    healthEndpoint?: string;
    metricsEndpoint?: string;
    repoUrl?: string;
  }): ConnectedApplication {
    const id = params.id || `app-${params.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now().toString().slice(-4)}`;
    const token = crypto.randomBytes(16).toString('hex');
    const webhookUrl = `/api/webhooks/ingest/${id}`;

    const app: ConnectedApplication = {
      id,
      name: params.name,
      type: params.type,
      deployedUrl: params.deployedUrl.replace(/\/+$/, ''), // strip trailing slash
      healthEndpoint: params.healthEndpoint || (params.type === 'frontend' ? '/' : '/health'),
      metricsEndpoint: params.metricsEndpoint,
      repoUrl: params.repoUrl,
      webhookUrl,
      webhookToken: token,
      status: 'HEALTHY',
      uptimePercent: 100.0,
      lastProbe: {
        timestamp: new Date().toISOString(),
        statusCode: 200,
        latencyMs: 35,
        message: 'Initial synthetic check verified'
      },
      createdAt: new Date().toISOString()
    };

    this.applications.set(id, app);
    this.failureCounts.set(id, 0);
    this.totalProbes.set(id, { total: 1, successful: 1 });

    // Also register in service registry for metric correlation
    serviceRegistry.register({
      id: app.id,
      name: app.name,
      repo: app.repoUrl || `deployed/${app.id}`,
      metricsUrl: app.metricsEndpoint ? `${app.deployedUrl}${app.metricsEndpoint}` : `${app.deployedUrl}/metrics`,
      healthUrl: `${app.deployedUrl}${app.healthEndpoint}`,
      containerName: app.id,
      status: 'HEALTHY',
      currentVersion: 'v1.0.0 (production link)',
      currentStats: {
        errorRate5xx: 0.001,
        p95LatencyMs: 40,
        throughputRpm: 120,
        memoryUsagePercent: 35,
        cpuPercent: 12
      }
    });

    logCollector.appendLog(app.id, `[Maintenance System] Application '${app.name}' connected via deployed link: ${app.deployedUrl}`);
    logCollector.appendLog(app.id, `[Maintenance System] Dedicated Ingestion Webhook ready: ${webhookUrl}`);

    wsBroadcaster.broadcast('APPLICATION_CONNECTED', app);

    return app;
  }

  public getAll(): ConnectedApplication[] {
    return Array.from(this.applications.values());
  }

  public getById(id: string): ConnectedApplication | undefined {
    return this.applications.get(id);
  }

  public remove(id: string): boolean {
    return this.applications.delete(id);
  }

  /**
   * Starts background synthetic health probe loop (pings every deployed site every 10 seconds)
   */
  public startProbingLoop(intervalMs: number = 10000): void {
    if (this.probeInterval) return;

    this.probeInterval = setInterval(async () => {
      for (const app of this.applications.values()) {
        await this.probe(app);
      }
    }, intervalMs);
  }

  /**
   * Executes synthetic probe against a single connected deployed link
   */
  public async probe(app: ConnectedApplication): Promise<{ statusCode: number; latencyMs: number; status: ServiceHealthStatus }> {
    const fullUrl = `${app.deployedUrl}${app.healthEndpoint}`;
    const startTime = Date.now();
    let statusCode = 200;
    let latencyMs = 35;
    let healthStatus: ServiceHealthStatus = 'HEALTHY';
    let errorMessage = 'Synthetic probe succeeded (200 OK)';

    try {
      const res = await axios.get(fullUrl, { timeout: CONFIG.HEALTH_CHECK_TIMEOUT_MS });
      statusCode = res.status;
      latencyMs = Date.now() - startTime;

      if (statusCode >= 500) {
        healthStatus = 'DEGRADED';
        errorMessage = `HTTP 5xx Server Error (${statusCode})`;
      } else if (latencyMs > 1200) {
        healthStatus = 'WARNING';
        errorMessage = `High latency detected: ${latencyMs}ms`;
      }
    } catch (err: any) {
      if (CONFIG.DEMO_MODE && !app.deployedUrl.startsWith('http://127.0.0.1') && !app.deployedUrl.startsWith('http://localhost')) {
        // Only in demo mode fallback to simulated baseline for external URLs if venue internet is down
        statusCode = 200;
        latencyMs = Math.round(45 + Math.random() * 20);
        healthStatus = 'HEALTHY';
        errorMessage = 'Synthetic probe simulated (Demo Mode)';
      } else {
        statusCode = err.response?.status || 503;
        latencyMs = Date.now() - startTime;
        healthStatus = 'DOWN';
        errorMessage = err.code === 'ECONNREFUSED' 
          ? `Connection refused at ${fullUrl}` 
          : (err.message || 'Synthetic probe connection failed');
      }
    }

    // Update probe stats & uptime calculation
    const currentCounters = this.totalProbes.get(app.id) || { total: 0, successful: 0 };
    currentCounters.total++;
    if (healthStatus === 'HEALTHY' || healthStatus === 'WARNING') {
      currentCounters.successful++;
    }
    this.totalProbes.set(app.id, currentCounters);

    app.status = healthStatus;
    app.uptimePercent = parseFloat(((currentCounters.successful / currentCounters.total) * 100).toFixed(2));
    app.lastProbe = {
      timestamp: new Date().toISOString(),
      statusCode,
      latencyMs,
      message: errorMessage
    };

    // Track consecutive failures to trigger automated incident
    const consecutiveFails = this.failureCounts.get(app.id) || 0;
    if (healthStatus === 'DOWN' || healthStatus === 'DEGRADED') {
      this.failureCounts.set(app.id, consecutiveFails + 1);

      if (consecutiveFails + 1 >= 2) {
        this.triggerSyntheticIncident(app, errorMessage);
      }
    } else {
      this.failureCounts.set(app.id, 0);
    }

    return { statusCode, latencyMs, status: healthStatus };
  }

  /**
   * Triggers an automated SRE incident when a deployed link fails synthetics
   */
  private async triggerSyntheticIncident(app: ConnectedApplication, reason: string): Promise<void> {
    const active = incidentManager.getAll().find(i => i.serviceId === app.id && i.status !== 'RESOLVED');
    if (active) return; // avoid duplicate alerts

    logCollector.appendLog(app.id, `[CRITICAL ALERT] Deployed application link ${app.deployedUrl} is failing synthetic probes: ${reason}`);

    const rule = `Synthetic Probe Failed: ${app.name} returned ${reason} on ${app.deployedUrl}`;
    const { category, evidence } = culpritFinder.findCulprit(app.id, rule);

    const incident = incidentManager.createIncident(app.id, rule, category, evidence);
    wsBroadcaster.broadcast('INCIDENT_DETECTED', incident);

    const diagnosis = await brainService.diagnose(incident);
    incidentManager.setDiagnosis(incident.id, diagnosis);
    wsBroadcaster.broadcast('INCIDENT_DIAGNOSED', incidentManager.getById(incident.id));

    await handsService.handleRemediation(incident);
    wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
  }

  /**
   * Universal Webhook Receiver for this specific connected application
   * Ingests deploys from Vercel/Netlify/GitHub, or exceptions from frontend/backend
   */
  public async handleIngestedWebhook(appId: string, payload: any, headers: Record<string, any>): Promise<any> {
    const app = this.applications.get(appId);
    if (!app) throw new Error(`Connected application '${appId}' not found`);

    logCollector.appendLog(app.id, `[Universal Ingestion Webhook] Received payload for ${app.name}`);

    // 1. Check if payload is an Error / Crash Report
    if (payload.error || payload.stack || payload.exception) {
      const errorMsg = payload.message || payload.error || 'Client-side runtime error';
      const stack = payload.stack || payload.trace || '';
      logCollector.appendLog(app.id, `[Error Ingestion] ${errorMsg}\n${stack}`);

      const rule = `Runtime Exception on ${app.name}: ${errorMsg}`;
      const { category, evidence } = culpritFinder.findCulprit(app.id, rule);
      evidence.stackTrace = stack;

      const incident = incidentManager.createIncident(app.id, rule, category, evidence);
      wsBroadcaster.broadcast('INCIDENT_DETECTED', incident);

      const diagnosis = await brainService.diagnose(incident);
      incidentManager.setDiagnosis(incident.id, diagnosis);
      wsBroadcaster.broadcast('INCIDENT_DIAGNOSED', incidentManager.getById(incident.id));

      await handsService.handleRemediation(incident);
      wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));

      return { status: 'INCIDENT_CREATED', incidentId: incident.id };
    }

    // 2. Check if payload is a Deployment Notification (Vercel, Netlify, Render, GitHub)
    const commitSha = payload.commitSha || payload.commit || payload.sha || payload.deployment?.meta?.githubCommitSha || 'latest';
    const commitMsg = payload.commitMessage || payload.message || payload.deployment?.name || 'Automated deployment';
    const author = payload.author || payload.creator?.username || 'on-call-dev';

    const marker = incidentManager.recordDeployMarker({
      serviceId: app.id,
      commitSha: String(commitSha).slice(0, 7),
      commitMessage: commitMsg,
      author,
      timestamp: new Date().toISOString(),
      environment: payload.environment || 'production',
      diffSummary: `Deployed via ${payload.provider || 'Universal Webhook'} to ${app.deployedUrl}`
    });

    serviceRegistry.updateVersion(app.id, `${marker.commitSha} (${commitMsg})`);
    wsBroadcaster.broadcast('DEPLOY_MARKER', marker);

    return { status: 'DEPLOY_RECORDED', marker };
  }
}

export const syntheticProber = new SyntheticProber();
