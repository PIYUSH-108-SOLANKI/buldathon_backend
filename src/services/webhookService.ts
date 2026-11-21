import crypto from 'crypto';
import axios from 'axios';
import { CONFIG } from '../config';
import { incidentManager } from './incidentManager';
import { serviceRegistry } from './serviceRegistry';
import { logCollector } from './logCollector';
import { culpritFinder } from './culpritFinder';
import { brainService } from './brainService';
import { handsService } from './handsService';
import { wsBroadcaster } from '../api/websocket';
import { Incident } from '../types';

export class WebhookService {
  /**
   * Validates GitHub X-Hub-Signature-256 header using HMAC-SHA256
   */
  public verifyGitHubSignature(rawBody: string, signatureHeader?: string): boolean {
    const secret = CONFIG.WEBHOOKS.GITHUB_SECRET;
    if (!secret) {
      // In demo/hackathon environment without secret configured, permit webhook
      return true;
    }
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }

    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSignature));
    } catch {
      return false;
    }
  }

  /**
   * Processes GitHub Webhook events (push, pull_request, workflow_run)
   */
  public handleGitHubEvent(event: string, payload: any): { processed: boolean; summary: string } {
    logCollector.appendLog('gateway-service', `[GitHub Webhook] Received '${event}' event from repository: ${payload.repository?.full_name || 'fake-shop'}`);

    if (event === 'push') {
      const commits = payload.commits || [];
      const latest = commits[commits.length - 1] || payload.head_commit;
      const serviceId = payload.repository?.name || 'orders-service';

      if (latest) {
        const marker = incidentManager.recordDeployMarker({
          serviceId,
          commitSha: latest.id?.slice(0, 7) || 'a1b2c3d',
          commitMessage: latest.message || 'push commit',
          author: latest.author?.name || latest.author?.email || 'developer',
          timestamp: new Date().toISOString(),
          environment: 'production',
          diffSummary: `Modified: ${[...(latest.added || []), ...(latest.modified || [])].join(', ') || 'codebase'}`
        });

        serviceRegistry.updateVersion(serviceId, `${marker.commitSha} (${marker.commitMessage})`);
        wsBroadcaster.broadcast('DEPLOY_MARKER', marker);

        return {
          processed: true,
          summary: `Push registered: ${marker.commitSha} by ${marker.author}`
        };
      }
    }

    if (event === 'pull_request') {
      const action = payload.action;
      const prNumber = payload.number;
      const changedFiles: string[] = payload.pull_request?.changed_files_list || [];

      // Check if dependency lockfile was modified (Sietch checkpoint)
      const hasDependencyChange = changedFiles.some(f => f.includes('package.json') || f.includes('package-lock.json'));

      logCollector.appendLog('orders-service', `[GitHub Webhook] PR #${prNumber} ${action} on ${payload.repository?.name || 'repo'}`);

      if (hasDependencyChange) {
        logCollector.appendLog('orders-service', `[SIETCH GATEWAY] PR #${prNumber} modifies npm packages. Routing to Sietch sandbox verification.`);
        wsBroadcaster.broadcast('SIETCH_INSPECTION_QUEUED', {
          prNumber,
          repo: payload.repository?.name,
          changedFiles
        });
      }

      return {
        processed: true,
        summary: `PR #${prNumber} ${action} processed. Dependency check: ${hasDependencyChange ? 'TRIGGERED SIETCH' : 'CLEAN'}`
      };
    }

    if (event === 'workflow_run') {
      const status = payload.workflow_run?.status;
      const conclusion = payload.workflow_run?.conclusion;
      logCollector.appendLog('gateway-service', `[CI/CD Workflow] '${payload.workflow_run?.name}' ${status} (${conclusion || 'in-progress'})`);
      return { processed: true, summary: `Workflow run ${status}` };
    }

    return { processed: true, summary: `Event '${event}' logged` };
  }

  /**
   * Processes Alertmanager Webhook (Prometheus Alertmanager format)
   */
  public async handleAlertmanagerAlert(payload: any): Promise<{ handled: boolean; incidentId?: string }> {
    const alerts = payload.alerts || [];
    if (alerts.length === 0) return { handled: false };

    for (const alert of alerts) {
      if (alert.status !== 'firing') continue;

      const labels = alert.labels || {};
      const annotations = alert.annotations || {};
      const serviceId = labels.service || labels.app || 'orders-service';
      const alertName = labels.alertname || 'HighErrorRate';
      const rule = annotations.summary || annotations.description || `${alertName} fired on ${serviceId}`;

      logCollector.appendLog(serviceId, `[Alertmanager Webhook] FIRING: ${alertName} (${rule})`);

      // 1. Correlate with Culprit Finder
      const { category, evidence } = culpritFinder.findCulprit(serviceId, rule);

      // 2. Create Incident (T1) with deduplication guard
      const alreadyActive = incidentManager.hasActiveIncident(serviceId);
      const incident = incidentManager.createIncident(serviceId, rule, category, evidence);

      if (!alreadyActive) {
        wsBroadcaster.broadcast('INCIDENT_DETECTED', incident);

        // 3. AI Brain Diagnosis (T2)
        const diagnosis = await brainService.diagnose(incident);
        incidentManager.setDiagnosis(incident.id, diagnosis);
        wsBroadcaster.broadcast('INCIDENT_DIAGNOSED', incidentManager.getById(incident.id));

        // 4. Dispatch Outgoing Notification (Slack/Discord)
        await this.dispatchOutgoingAlert(incident);

        // 5. Remediation via The Hands
        await handsService.handleRemediation(incident);
        wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
      }

      return { handled: true, incidentId: incident.id };
    }

    return { handled: true };
  }

  /**
   * Processes Grafana unified alerting webhook
   */
  public async handleGrafanaAlert(payload: any): Promise<{ handled: boolean; incidentId?: string }> {
    const ruleName = payload.ruleName || payload.title || 'Grafana Metric Threshold Alert';
    const state = payload.state || 'alerting';
    const serviceId = payload.labels?.service || 'orders-service';

    logCollector.appendLog(serviceId, `[Grafana Webhook] State: ${state.toUpperCase()} | Rule: ${ruleName}`);

    if (state === 'alerting') {
      const rule = `Grafana Alert: ${ruleName} (Threshold breached)`;
      const { category, evidence } = culpritFinder.findCulprit(serviceId, rule);

      const alreadyActive = incidentManager.hasActiveIncident(serviceId);
      const incident = incidentManager.createIncident(serviceId, rule, category, evidence);

      if (!alreadyActive) {
        wsBroadcaster.broadcast('INCIDENT_DETECTED', incident);

        const diagnosis = await brainService.diagnose(incident);
        incidentManager.setDiagnosis(incident.id, diagnosis);
        wsBroadcaster.broadcast('INCIDENT_DIAGNOSED', incidentManager.getById(incident.id));

        await this.dispatchOutgoingAlert(incident);
        await handsService.handleRemediation(incident);
        wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
      }

      return { handled: true, incidentId: incident.id };
    }

    return { handled: true };
  }

  /**
   * Dispatches outgoing webhook alerts to Slack or Discord for on-call notification
   */
  public async dispatchOutgoingAlert(incident: Incident): Promise<void> {
    const slackUrl = CONFIG.WEBHOOKS.SLACK_URL;
    const discordUrl = CONFIG.WEBHOOKS.DISCORD_URL;

    if (!slackUrl && !discordUrl) return;

    const diag = incident.diagnosis;
    const message = {
      text: `🚨 *[SRE AGENT ALARM]* Incident *${incident.id}* on \`${incident.serviceId}\``,
      attachments: [
        {
          color: incident.severity === 'CRITICAL' ? '#e02424' : '#f59e0b',
          title: incident.title,
          fields: [
            { title: 'Status', value: incident.status, short: true },
            { title: 'Safety Tier', value: diag?.safetyTier || 'AUTO_FIX', short: true },
            { title: 'Diagnosis', value: diag?.rootCause || 'Under investigation', short: false },
            { title: 'Remediation', value: diag?.suggestedFix.description || 'N/A', short: false }
          ],
          footer: 'AI Site-Reliability Agent (AIA-02)',
          ts: Math.floor(Date.now() / 1000)
        }
      ]
    };

    try {
      if (slackUrl) await axios.post(slackUrl, message, { timeout: 2000 });
      if (discordUrl) await axios.post(discordUrl, { content: message.text }, { timeout: 2000 });
      logCollector.appendLog(incident.serviceId, `[Notification Webhook] Dispatched incident alert to on-call channel.`);
    } catch (err: any) {
      console.warn(`[Webhook Notification] Could not send notification: ${err.message}`);
    }
  }
}

export const webhookService = new WebhookService();
