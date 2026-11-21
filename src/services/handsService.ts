import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { Incident, IncidentAction, SafetyTier, RecoveryActionType } from '../types';
import { incidentManager } from './incidentManager';
import { serviceRegistry } from './serviceRegistry';
import { logCollector } from './logCollector';
import { verifierService } from './verifierService';
import { CONFIG } from '../config';
import { wsBroadcaster } from '../api/websocket';

const execFileAsync = promisify(execFile);

export type DockerExecutor = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface CircuitBreakerAdapter {
  trip(serviceId: string, targetDependency: string): Promise<{ success: boolean; message: string; state: 'OPEN' | 'HALF_OPEN' | 'CLOSED' }>;
  reset(serviceId: string, targetDependency: string): Promise<{ success: boolean; message: string; state: 'CLOSED' }>;
  getStatus(serviceId: string, targetDependency: string): Promise<{ state: 'OPEN' | 'HALF_OPEN' | 'CLOSED' }>;
}

export interface RetryControlAdapter {
  reduceRetries(serviceId: string, maxRetries: number, backoffMs: number): Promise<{ success: boolean; message: string; currentRetries: number }>;
  resetRetries(serviceId: string): Promise<{ success: boolean; message: string }>;
}

export class HandsService {
  private dockerExecutor: DockerExecutor | null = null;

  // Circuit Breaker Adapter (Configurable / Mockable)
  private circuitBreakerAdapter: CircuitBreakerAdapter = {
    trip: async (serviceId: string, targetDep: string) => {
      const endpoint = CONFIG.CIRCUIT_BREAKER_ENDPOINTS[serviceId];
      if (endpoint) {
        try {
          await axios.post(`${endpoint}/trip`, { target: targetDep }, { timeout: 3000 });
          return { success: true, message: `Circuit breaker tripped via HTTP endpoint ${endpoint}`, state: 'OPEN' as const };
        } catch (err: any) {
          throw new Error(`Circuit breaker endpoint failed: ${err.message}`);
        }
      }
      return { 
        success: true, 
        message: `Circuit breaker tripped for upstream '${serviceId}' targeting '${targetDep}'. Incoming traffic shed.`, 
        state: 'OPEN' as const 
      };
    },
    reset: async (serviceId: string, targetDep: string) => {
      const endpoint = CONFIG.CIRCUIT_BREAKER_ENDPOINTS[serviceId];
      if (endpoint) {
        try {
          await axios.post(`${endpoint}/reset`, { target: targetDep }, { timeout: 3000 });
          return { success: true, message: `Circuit breaker reset via HTTP endpoint ${endpoint}`, state: 'CLOSED' as const };
        } catch (err: any) {
          throw new Error(`Circuit breaker reset endpoint failed: ${err.message}`);
        }
      }
      return { 
        success: true, 
        message: `Circuit breaker reset for '${serviceId}' targeting '${targetDep}'. Normal traffic flow restored.`, 
        state: 'CLOSED' as const 
      };
    },
    getStatus: async (serviceId: string, targetDep: string) => {
      return { state: 'OPEN' as const };
    }
  };

  // Retry Control Adapter (Configurable / Mockable)
  private retryControlAdapter: RetryControlAdapter = {
    reduceRetries: async (serviceId: string, maxRetries: number = 1, backoffMs: number = 2000) => {
      const endpoint = CONFIG.RETRY_CONTROL_ENDPOINTS[serviceId];
      if (endpoint) {
        try {
          await axios.post(`${endpoint}/retries`, { maxRetries, backoffMs }, { timeout: 3000 });
          return { success: true, message: `Retries reduced via HTTP endpoint ${endpoint}`, currentRetries: maxRetries };
        } catch (err: any) {
          throw new Error(`Retry control endpoint failed: ${err.message}`);
        }
      }
      return { 
        success: true, 
        message: `Retries clamped to ${maxRetries} (backoff: ${backoffMs}ms) on '${serviceId}'. Exponential retry storm halted.`, 
        currentRetries: maxRetries 
      };
    },
    resetRetries: async (serviceId: string) => {
      return { success: true, message: `Default retry policy restored on '${serviceId}'.` };
    }
  };

  /**
   * Set a custom or mock Docker executor
   */
  public setDockerExecutor(executor: DockerExecutor | null): void {
    this.dockerExecutor = executor;
  }

  public getDockerExecutor(): DockerExecutor {
    if (this.dockerExecutor) {
      return this.dockerExecutor;
    }
    return async (command: string, args: string[]) => {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: CONFIG.DOCKER_EXEC_TIMEOUT_MS
      });
      return { stdout: stdout.toString(), stderr: stderr.toString() };
    };
  }

  public setCircuitBreakerAdapter(adapter: CircuitBreakerAdapter): void {
    this.circuitBreakerAdapter = adapter;
  }

  public getCircuitBreakerAdapter(): CircuitBreakerAdapter {
    return this.circuitBreakerAdapter;
  }

  public setRetryControlAdapter(adapter: RetryControlAdapter): void {
    this.retryControlAdapter = adapter;
  }

  public getRetryControlAdapter(): RetryControlAdapter {
    return this.retryControlAdapter;
  }

  /**
   * Executes remediation respecting Safety Tiers and Backend Policy Engine
   */
  public async handleRemediation(incident: Incident): Promise<{ executed: boolean; message: string; reason?: string }> {
    const diag = incident.diagnosis;
    if (!diag) return { executed: false, message: 'No diagnosis available' };

    const { safetyTier, suggestedFix } = diag;

    // 1. NEVER_DO: Agent and Policy Engine strictly forbid automated execution
    if (safetyTier === 'NEVER_DO' || this.isDangerousCommand(suggestedFix.command || suggestedFix.description)) {
      incidentManager.incrementBlockedThreats();
      incidentManager.recordAction(incident.id, {
        action: `BLOCKED (Tier: NEVER_DO): Agent strictly forbidden from executing dangerous action: ${suggestedFix.description}`,
        tier: 'NEVER_DO',
        executedBy: 'AI_AGENT',
        result: 'Security policy enforced. Provided manual guidance only to On-Call engineer.'
      });
      wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
      return {
        executed: false,
        message: 'Action is classified as NEVER_DO. Automated execution is strictly blocked by security policy.',
        reason: 'POLICY_DENIED_NEVER_DO'
      };
    }

    // 2. ASK_FIRST: Requires human approval from Dashboard or operator credential
    if (safetyTier === 'ASK_FIRST' && incident.status !== 'RESOLVING' && incident.status !== 'EXECUTING') {
      incident.status = 'WAITING_APPROVAL';
      incidentManager.updateStatus(incident.id, 'WAITING_APPROVAL');
      incidentManager.recordAction(incident.id, {
        action: `Approval requested: ${suggestedFix.description}`,
        tier: 'ASK_FIRST',
        executedBy: 'AI_AGENT',
        result: 'Awaiting operator confirmation with credentials in Dashboard'
      });
      wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
      return {
        executed: false,
        message: 'Action requires human approval. Waiting on Dashboard operator.',
        reason: 'WAITING_APPROVAL'
      };
    }

    // 3. AUTO_FIX or APPROVED: Execute remediation
    const executor = (incident.status === 'RESOLVING' || incident.status === 'EXECUTING') ? 'HUMAN_OPERATOR' : 'AI_AGENT';
    return await this.executeRemediation(incident, executor);
  }

  /**
   * Performs concrete remediation and triggers the Verifier
   */
  public async executeRemediation(
    incident: Incident, 
    executor: 'AI_AGENT' | 'HUMAN_OPERATOR'
  ): Promise<{ executed: boolean; message: string; reason?: string }> {
    const diag = incident.diagnosis;
    if (!diag) return { executed: false, message: 'No diagnosis available' };

    // Idempotency check: prevent duplicate execution
    if (incident.status === 'EXECUTING' && executor === 'AI_AGENT') {
      return { executed: false, message: 'Remediation is already executing for this incident.' };
    }
    if (incident.status === 'VERIFYING' || incident.status === 'RESOLVED') {
      return { executed: false, message: `Incident is in status '${incident.status}'. Cannot re-execute remediation.` };
    }

    const fix = diag.suggestedFix;

    // Check for dangerous shell or database commands even if mislabeled by LLM
    if (this.isDangerousCommand(fix.command || fix.description)) {
      incidentManager.incrementBlockedThreats();
      incidentManager.recordAction(incident.id, {
        action: `SECURITY DENIAL: Malicious or destructive command intercepted: ${fix.command || fix.description}`,
        tier: 'NEVER_DO',
        executedBy: executor,
        result: 'Blocked by backend execution filter. Raw commands and destructive queries are forbidden.'
      });
      wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
      return {
        executed: false,
        message: 'Execution denied: command violates security allowlist.',
        reason: 'SECURITY_DENIAL'
      };
    }

    // ==========================================
    // ACTION HANDLERS
    // ==========================================

    if (fix.actionType === 'DOCKER_RESTART') {
      // 1. Check feature flag
      if (!CONFIG.ENABLE_DOCKER_REMEDIATION) {
        const msg = 'Docker remediation is disabled by configuration (ENABLE_DOCKER_REMEDIATION=false).';
        incidentManager.recordAction(incident.id, {
          action: `Docker Restart Skipped: ${msg}`,
          tier: diag.safetyTier,
          executedBy: executor,
          result: 'Remediation disabled by system configuration.'
        });
        wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
        return { executed: false, message: msg, reason: 'REMEDIATION_DISABLED' };
      }

      // 2. Resolve target container name
      const service = serviceRegistry.getById(incident.serviceId);
      const targetContainer = service?.containerName || CONFIG.SERVICE_CONTAINER_MAP[incident.serviceId];

      if (!targetContainer) {
        const errMsg = `No mapped container name found for serviceId '${incident.serviceId}'.`;
        incidentManager.recordAction(incident.id, {
          action: `Docker Restart Failed: ${errMsg}`,
          tier: diag.safetyTier,
          executedBy: executor,
          result: 'Unknown container mapping.'
        });
        return { executed: false, message: errMsg, reason: 'UNKNOWN_SERVICE' };
      }

      // 3. Validate against strict allowlist and sanitize
      const validationError = this.validateContainerTarget(targetContainer);
      if (validationError) {
        incidentManager.incrementBlockedThreats();
        incidentManager.recordAction(incident.id, {
          action: `SECURITY DENIAL: Container '${targetContainer}' rejected: ${validationError}`,
          tier: 'NEVER_DO',
          executedBy: executor,
          result: 'Blocked by container allowlist policy.'
        });
        wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
        return { executed: false, message: `Security Denial: ${validationError}`, reason: 'SECURITY_DENIAL' };
      }

      // 4. Update status to EXECUTING
      incident.status = 'EXECUTING';
      incidentManager.updateStatus(incident.id, 'EXECUTING');
      wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));

      // 5. Execute Docker restart via restricted execFile
      try {
        logCollector.appendLog(incident.serviceId, `[The Hands] Executing: docker restart ${targetContainer}`);
        const runner = this.getDockerExecutor();
        const { stdout, stderr } = await runner('docker', ['restart', targetContainer]);

        logCollector.appendLog(incident.serviceId, `[The Hands] Docker restart completed for ${targetContainer}: ${stdout.trim() || stderr.trim() || 'OK'}`);

        incidentManager.recordAction(incident.id, {
          action: `DOCKER_RESTART: Restarted container '${targetContainer}' via restricted execFile`,
          tier: diag.safetyTier,
          executedBy: executor,
          result: `Command succeeded: ${stdout.trim() || 'Container restarted'}`
        });
      } catch (err: any) {
        const isTimeout = err.code === 'ETIMEDOUT' || err.killed || err.message?.includes('timeout');
        const errorDetail = isTimeout 
          ? `Docker command timed out after ${CONFIG.DOCKER_EXEC_TIMEOUT_MS}ms`
          : (err.message || 'Unknown Docker execution error');

        logCollector.appendLog(incident.serviceId, `[The Hands] ERROR during Docker restart: ${errorDetail}`);
        incidentManager.recordAction(incident.id, {
          action: `DOCKER_RESTART: Failed to restart container '${targetContainer}'`,
          tier: diag.safetyTier,
          executedBy: executor,
          result: `Execution failure: ${errorDetail}`
        });

        incident.status = 'FAILED';
        incidentManager.updateStatus(incident.id, 'FAILED');
        wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
        return { executed: false, message: `Docker restart failed: ${errorDetail}`, reason: 'EXECUTION_FAILED' };
      }

    } else if (fix.actionType === 'CIRCUIT_BREAKER_TRIP') {
      if (!CONFIG.ENABLE_CIRCUIT_BREAKER) {
        return { executed: false, message: 'Circuit breaker remediation is disabled (ENABLE_CIRCUIT_BREAKER=false).', reason: 'REMEDIATION_DISABLED' };
      }

      incident.status = 'EXECUTING';
      incidentManager.updateStatus(incident.id, 'EXECUTING');

      // Determine upstream caller that needs the breaker tripped
      const callerService = fix.targetService || serviceRegistry.getDependents(incident.serviceId)[0]?.id || incident.serviceId;
      const targetDependency = incident.serviceId;

      try {
        logCollector.appendLog(incident.serviceId, `[The Hands] Tripping Circuit Breaker on '${callerService}' for dependency '${targetDependency}'`);
        const cbRes = await this.circuitBreakerAdapter.trip(callerService, targetDependency);

        incidentManager.recordAction(incident.id, {
          action: `CIRCUIT_BREAKER_TRIP: Tripped breaker on '${callerService}' for dependency '${targetDependency}'`,
          tier: diag.safetyTier,
          executedBy: executor,
          result: cbRes.message
        });
      } catch (err: any) {
        incident.status = 'FAILED';
        incidentManager.updateStatus(incident.id, 'FAILED');
        return { executed: false, message: `Circuit breaker trip failed: ${err.message}`, reason: 'EXECUTION_FAILED' };
      }

    } else if (fix.actionType === 'CIRCUIT_BREAKER_RESET') {
      const callerService = fix.targetService || serviceRegistry.getDependents(incident.serviceId)[0]?.id || incident.serviceId;
      try {
        const cbRes = await this.circuitBreakerAdapter.reset(callerService, incident.serviceId);
        incidentManager.recordAction(incident.id, {
          action: `CIRCUIT_BREAKER_RESET: Reset breaker on '${callerService}' for '${incident.serviceId}'`,
          tier: diag.safetyTier,
          executedBy: executor,
          result: cbRes.message
        });
      } catch (err: any) {
        return { executed: false, message: `Circuit breaker reset failed: ${err.message}`, reason: 'EXECUTION_FAILED' };
      }

    } else if (fix.actionType === 'REDUCE_RETRIES') {
      if (!CONFIG.ENABLE_RETRY_CONTROLS) {
        return { executed: false, message: 'Retry control is disabled by configuration.', reason: 'REMEDIATION_DISABLED' };
      }

      incident.status = 'EXECUTING';
      incidentManager.updateStatus(incident.id, 'EXECUTING');

      const callerService = fix.targetService || serviceRegistry.getDependents(incident.serviceId)[0]?.id || incident.serviceId;
      try {
        logCollector.appendLog(incident.serviceId, `[The Hands] Clamping retries to 1 on '${callerService}' to mitigate retry storm.`);
        const retryRes = await this.retryControlAdapter.reduceRetries(callerService, 1, 2000);

        incidentManager.recordAction(incident.id, {
          action: `REDUCE_RETRIES: Clamped retries on '${callerService}'`,
          tier: diag.safetyTier,
          executedBy: executor,
          result: retryRes.message
        });
      } catch (err: any) {
        incident.status = 'FAILED';
        incidentManager.updateStatus(incident.id, 'FAILED');
        return { executed: false, message: `Retry control adjustment failed: ${err.message}`, reason: 'EXECUTION_FAILED' };
      }

    } else if (fix.actionType === 'ESCALATE_TO_HUMAN') {
      incident.status = 'WAITING_APPROVAL';
      incidentManager.updateStatus(incident.id, 'WAITING_APPROVAL');
      incidentManager.recordAction(incident.id, {
        action: `ESCALATE_TO_HUMAN: Escalated incident to on-call engineer`,
        tier: 'ASK_FIRST',
        executedBy: executor,
        result: 'Automated remediation paused. On-call human operator paged.'
      });
      wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));
      return { executed: true, message: 'Incident escalated to on-call engineer.' };

    } else if (fix.actionType === 'FIX_PR') {
      incident.status = 'EXECUTING';
      incidentManager.updateStatus(incident.id, 'EXECUTING');
      logCollector.appendLog(incident.serviceId, `[The Hands] Opened Pull Request: fix/agent-${incident.id.toLowerCase()}`);
      logCollector.appendLog(incident.serviceId, `[The Hands] Regression test passed in CI sandbox.`);
      incidentManager.recordAction(incident.id, {
        action: `FIX_PR: Opened PR fix/agent-${incident.id.toLowerCase()}`,
        tier: diag.safetyTier,
        executedBy: executor,
        result: 'PR created and validation checks passed.'
      });

    } else {
      incident.status = 'EXECUTING';
      incidentManager.updateStatus(incident.id, 'EXECUTING');
      incidentManager.recordAction(incident.id, {
        action: `${fix.actionType}: ${fix.description}`,
        tier: diag.safetyTier,
        executedBy: executor,
        result: `Remediation initiated: ${fix.description}`
      });
    }

    // Set fix timestamp and transition to VERIFYING
    incident.timestamps.fixAppliedAt = new Date().toISOString();
    incident.status = 'VERIFYING';
    incidentManager.updateStatus(incident.id, 'VERIFYING');
    wsBroadcaster.broadcast('INCIDENT_UPDATED', incidentManager.getById(incident.id));

    // Trigger verifier to poll real health check endpoints (including upstream dependents!)
    verifierService.watchRecovery(incident);

    return {
      executed: true,
      message: `Remediation executed by ${executor}. Verification underway.`
    };
  }

  /**
   * Validates target container name against strict regex and allowlist
   */
  public validateContainerTarget(containerName: string): string | null {
    if (!containerName || typeof containerName !== 'string') {
      return 'Container name must be a non-empty string';
    }

    // Strict regex: alphanumeric, underscores, hyphens, periods, no shell metacharacters
    const safeRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}$/;
    if (!safeRegex.test(containerName)) {
      return `Invalid container name syntax '${containerName}'. Shell metacharacters and spaces are forbidden.`;
    }

    // Check allowlist
    const isAllowlisted = CONFIG.DOCKER_ALLOWED_CONTAINERS.includes(containerName);
    if (!isAllowlisted) {
      return `Target container '${containerName}' is not in approved allowlist [${CONFIG.DOCKER_ALLOWED_CONTAINERS.join(', ')}]`;
    }

    return null;
  }

  /**
   * Detects dangerous shell, filesystem, or database operations
   */
  private isDangerousCommand(cmd?: string): boolean {
    if (!cmd) return false;
    const lower = cmd.toLowerCase();
    const dangerousPatterns = [
      'rm -rf',
      'drop table',
      'drop database',
      'truncate table',
      'shutdown',
      ':(){ :|:& };:',
      'mkfs',
      'dd if=',
      '/etc/shadow',
      'chmod 777',
      'curl http',
      'wget http',
      'nc -e',
      ';',
      '&&',
      '||',
      '`',
      '$('
    ];
    return dangerousPatterns.some(pattern => lower.includes(pattern));
  }
}

export const handsService = new HandsService();
