import axios from 'axios';
import { Incident, VerificationCheck } from '../types';
import { incidentManager } from './incidentManager';
import { serviceRegistry } from './serviceRegistry';
import { brainService } from './brainService';
import { metricsCollector } from './metricsCollector';
import { logCollector } from './logCollector';
import { CONFIG } from '../config';
import { wsBroadcaster } from '../api/websocket';

export class VerifierService {
  /**
   * Watches service recovery via genuine polling of the real health and metrics endpoints.
   * Also verifies that upstream callers and dependent services have stabilized, ensuring
   * cascading failures have been successfully arrested.
   */
  public async watchRecovery(
    incident: Incident, 
    pollIntervalMs: number = 1500, 
    maxWaitMs: number = CONFIG.VERIFICATION_WINDOW_SEC * 1000
  ): Promise<boolean> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const service = serviceRegistry.getById(incident.serviceId);

    if (!service) {
      logCollector.appendLog(incident.serviceId, `[Verifier] ERROR: Service '${incident.serviceId}' not found in registry.`);
      incident.status = 'FAILED';
      incidentManager.updateStatus(incident.id, 'FAILED');
      return false;
    }

    logCollector.appendLog(
      incident.serviceId, 
      `[Verifier] Starting recovery verification for ${service.id} (polling ${service.healthUrl} up to ${Math.round(maxWaitMs / 1000)}s)...`
    );

    const checks: VerificationCheck[] = [];

    while (Date.now() - startTime < maxWaitMs) {
      const now = new Date().toISOString();
      try {
        // 1. Probe primary service real HTTP /health endpoint
        const healthRes = await axios.get(service.healthUrl, { 
          timeout: CONFIG.HEALTH_CHECK_TIMEOUT_MS,
          validateStatus: () => true
        });

        if (healthRes.status === 200) {
          checks.push({
            check: 'HTTP /health Probe',
            status: 'PASSED',
            detail: `Endpoint ${service.healthUrl} returned HTTP 200 OK`,
            timestamp: now,
            targetServiceId: service.id
          });

          // 2. Validate Prometheus telemetry for primary service
          const scrape = await metricsCollector.scrapeService(service.id, service.metricsUrl, service.healthUrl);
          const errorRate = scrape.stats.errorRate5xx;
          const isErrorRateAcceptable = errorRate === null || errorRate <= CONFIG.THRESHOLDS.ERROR_RATE_MAX;

          if (isErrorRateAcceptable) {
            checks.push({
              check: 'Prometheus Telemetry Verification',
              status: 'PASSED',
              detail: `Telemetry stabilized: errorRate5xx=${errorRate !== null ? (errorRate * 100).toFixed(1) + '%' : 'N/A'}, p95LatencyMs=${scrape.stats.p95LatencyMs ?? 'N/A'}ms`,
              timestamp: now,
              targetServiceId: service.id
            });

            // 3. Cascading Failure Check: Validate upstream dependent services that were degraded or impacted
            const isCascading = incident.diagnosis?.isCascadingFailure === true;
            const dependents = serviceRegistry.getDependents(service.id);
            const impactedDependents = dependents.filter(d => isCascading || d.status !== 'HEALTHY');
            let allDependentsHealthy = true;

            for (const dep of impactedDependents) {
              try {
                const depRes = await axios.get(dep.healthUrl, {
                  timeout: CONFIG.HEALTH_CHECK_TIMEOUT_MS,
                  validateStatus: () => true
                });

                if (depRes.status === 200) {
                  const depScrape = await metricsCollector.scrapeService(dep.id, dep.metricsUrl, dep.healthUrl);
                  const depErr = depScrape.stats.errorRate5xx;
                  const isDepHealthy = depErr === null || depErr <= CONFIG.THRESHOLDS.ERROR_RATE_MAX;

                  if (isDepHealthy) {
                    checks.push({
                      check: `Dependent Upstream Health (${dep.id})`,
                      status: 'PASSED',
                      detail: `Dependent '${dep.id}' responded HTTP 200 and telemetry stabilized.`,
                      timestamp: now,
                      targetServiceId: dep.id
                    });
                    serviceRegistry.updateStats(dep.id, depScrape.stats, 'HEALTHY');
                  } else {
                    allDependentsHealthy = false;
                    checks.push({
                      check: `Dependent Upstream Health (${dep.id})`,
                      status: 'FAILED',
                      detail: `Dependent '${dep.id}' error rate still elevated (${(depErr! * 100).toFixed(1)}%). Cascading impact persists.`,
                      timestamp: now,
                      targetServiceId: dep.id
                    });
                  }
                } else {
                  allDependentsHealthy = false;
                  checks.push({
                    check: `Dependent Upstream Health (${dep.id})`,
                    status: 'FAILED',
                    detail: `Dependent '${dep.id}' health probe returned HTTP ${depRes.status}.`,
                    timestamp: now,
                    targetServiceId: dep.id
                  });
                }
              } catch (err: any) {
                allDependentsHealthy = false;
                checks.push({
                  check: `Dependent Upstream Health (${dep.id})`,
                  status: 'FAILED',
                  detail: `Dependent '${dep.id}' health probe failed: ${err.message}`,
                  timestamp: now,
                  targetServiceId: dep.id
                });
              }
            }

            if (allDependentsHealthy) {
              // Primary service AND all dependent upstream callers are confirmed healthy
              serviceRegistry.updateStats(service.id, scrape.stats, 'HEALTHY');

              incident.evidence.verificationEvidence = {
                startedAt,
                completedAt: now,
                checks
              };

              logCollector.appendLog(
                incident.serviceId, 
                `[Verifier] Service ${service.id} and dependent callers recovery CONFIRMED via real health probes & metrics!`
              );

              // Generate postmortem & resolve incident
              const postmortem = brainService.generatePostmortem(incident);
              incident.status = 'RESOLVED';
              incidentManager.resolveIncident(incident.id, postmortem);

              incidentManager.recordAction(incident.id, {
                action: 'Verifier Confirmation',
                tier: incident.diagnosis?.safetyTier || 'AUTO_FIX',
                executedBy: 'AI_AGENT',
                result: `Recovery verified: /health responded HTTP 200, dependent services stabilized. Postmortem generated.`
              });

              wsBroadcaster.broadcast('INCIDENT_RESOLVED', incidentManager.getById(incident.id));
              wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
              return true;
            } else {
              logCollector.appendLog(
                incident.serviceId,
                `[Verifier] Primary service '${service.id}' healthy, but upstream callers remain degraded. Waiting for cascading recovery...`
              );
            }
          } else {
            checks.push({
              check: 'Prometheus Telemetry Verification',
              status: 'FAILED',
              detail: `Health check passed but error rate still elevated (${(errorRate! * 100).toFixed(1)}% > ${CONFIG.THRESHOLDS.ERROR_RATE_MAX * 100}%)`,
              timestamp: now,
              targetServiceId: service.id
            });
          }
        } else {
          checks.push({
            check: 'HTTP /health Probe',
            status: 'FAILED',
            detail: `Health check returned HTTP ${healthRes.status} (expected 200)`,
            timestamp: now,
            targetServiceId: service.id
          });
        }
      } catch (err: any) {
        checks.push({
          check: 'HTTP /health Probe',
          status: 'FAILED',
          detail: `Health check failed: ${err.message}`,
          timestamp: now,
          targetServiceId: service.id
        });
      }

      // Wait before next poll iteration
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    // Verification window expired without sustained recovery
    const completedAt = new Date().toISOString();
    incident.evidence.verificationEvidence = {
      startedAt,
      completedAt,
      checks
    };

    logCollector.appendLog(
      incident.serviceId, 
      `[Verifier] TIMEOUT: Recovery verification failed to confirm service and dependency recovery within ${Math.round(maxWaitMs / 1000)}s.`
    );

    incident.status = 'FAILED';
    incidentManager.updateStatus(incident.id, 'FAILED');
    incidentManager.recordAction(incident.id, {
      action: 'Verifier Check Failed',
      tier: incident.diagnosis?.safetyTier || 'AUTO_FIX',
      executedBy: 'AI_AGENT',
      result: `Verification timed out after ${Math.round(maxWaitMs / 1000)}s. Application or dependent services failed to recover.`
    });

    wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
    return false;
  }

  /**
   * Performs an immediate single-probe recovery check
   */
  public async verifyOnce(incident: Incident): Promise<{ recovered: boolean; detail: string; checks: VerificationCheck[] }> {
    const service = serviceRegistry.getById(incident.serviceId);
    if (!service) {
      return { recovered: false, detail: `Service '${incident.serviceId}' not found`, checks: [] };
    }

    const now = new Date().toISOString();
    try {
      const res = await axios.get(service.healthUrl, { timeout: CONFIG.HEALTH_CHECK_TIMEOUT_MS, validateStatus: () => true });
      if (res.status === 200) {
        const check: VerificationCheck = {
          check: 'HTTP /health Probe',
          status: 'PASSED',
          detail: `Endpoint returned HTTP 200 OK`,
          timestamp: now,
          targetServiceId: service.id
        };
        return { recovered: true, detail: 'Health check returned HTTP 200', checks: [check] };
      } else {
        const check: VerificationCheck = {
          check: 'HTTP /health Probe',
          status: 'FAILED',
          detail: `Endpoint returned HTTP ${res.status}`,
          timestamp: now,
          targetServiceId: service.id
        };
        return { recovered: false, detail: `Health check returned HTTP ${res.status}`, checks: [check] };
      }
    } catch (err: any) {
      const check: VerificationCheck = {
        check: 'HTTP /health Probe',
        status: 'FAILED',
        detail: err.message,
        timestamp: now,
        targetServiceId: service.id
      };
      return { recovered: false, detail: `Connection error: ${err.message}`, checks: [check] };
    }
  }
}

export const verifierService = new VerifierService();
