import { 
  Incident, 
  IncidentStatus, 
  DeployMarker, 
  Scorecard, 
  IncidentEvidence, 
  IncidentDiagnosis, 
  IncidentAction, 
  SafetyTier 
} from '../types';
import { CONFIG } from '../config';

export class IncidentManager {
  private incidents: Map<string, Incident> = new Map();
  private deployMarkers: DeployMarker[] = [];
  private threatsBlockedCount = 0;

  constructor() {
    this.seedHistoricalData();
  }

  private seedHistoricalData() {
    // Seed an initial deployment marker
    this.deployMarkers.push({
      id: 'dep-001',
      serviceId: 'orders-service',
      commitSha: 'e4c172d',
      commitMessage: 'feat(orders): refactor checkout payload validation',
      author: 'dev-alex@company.com',
      timestamp: new Date(Date.now() - 3600000).toISOString(),
      environment: 'production',
      diffSummary: 'Changed order.service.ts (+14, -6) - added item options parsing'
    });

    // Seed a previous successfully resolved incident to demonstrate the scorecard & postmortem immediately
    const pastIncidentId = 'INC-20261121-001';
    const t0 = new Date(Date.now() - 7200000).toISOString();
    const t1 = new Date(Date.now() - 7180000).toISOString();
    const t2 = new Date(Date.now() - 7162000).toISOString(); // 18 seconds diagnosis
    const t3 = new Date(Date.now() - 7140000).toISOString();
    const t4 = new Date(Date.now() - 7080000).toISOString();

    const historicalIncident: Incident = {
      id: pastIncidentId,
      serviceId: 'orders-service',
      title: 'Checkout API 5xx Spikes Following v2.0.9 Release',
      ruleTriggered: '5xx error rate exceeded threshold: 14.2% (Threshold: 5%)',
      category: 'CODE_BUG',
      status: 'RESOLVED',
      severity: 'CRITICAL',
      timestamps: {
        faultStartedAt: t0,
        alarmRaisedAt: t1,
        causeNamedAt: t2,
        fixAppliedAt: t3,
        resolvedAt: t4,
        timeToDiagnosisSeconds: 18,
        timeToRecoverySeconds: 100
      },
      evidence: {
        metricSnapshots: {
          errorRate: 0.142,
          p95LatencyMs: 140,
          ordersRpm: 120
        },
        recentLogs: [
          'ERROR [orders] Uncaught Exception: TypeError: Cannot read properties of undefined (reading items)',
          '    at OrderService.createOrder (order.service.ts:42:27)'
        ],
        stackTrace: `TypeError: Cannot read properties of undefined (reading 'items')
    at OrderService.createOrder (order.service.ts:42:27)`,
        suspectCommit: {
          sha: 'b83d10c',
          message: 'feat: add bundle checkout',
          author: 'dev-alex@company.com',
          file: 'src/services/order.service.ts',
          line: 42,
          diff: '+ const items = req.body.order.items;'
        }
      },
      diagnosis: {
        diagnosisSource: 'DETERMINISTIC_HEURISTIC',
        summary: 'Checkout endpoint throwing TypeError due to unchecked payload property.',
        rootCause: 'Unchecked nested property access (req.body.order.items) threw TypeError when order wrapper was omitted in payload.',
        evidence: [
          'TypeError at OrderService.createOrder (order.service.ts:42)',
          '5xx error spike to 14.2% following commit b83d10c'
        ],
        confidence: 0.98,
        uncertainty: 'High confidence due to unambiguous stack trace matching commit diff.',
        blastRadius: 'Limited to checkout order submission API (/api/v1/orders).',
        recoveryStrategies: [
          {
            name: 'Null-safe Optional Chaining Fix PR',
            description: 'Apply defensive null-checks for req.body.order.items',
            actionType: 'FIX_PR',
            tier: 'AUTO_FIX',
            risks: 'Low risk, fully backward-compatible with legacy and new client payloads.'
          }
        ],
        explanation: 'Commit b83d10c introduced direct access to req.body.order.items without optional chaining or backward compatibility for legacy clients.',
        safetyTier: 'AUTO_FIX',
        suggestedFix: {
          actionType: 'FIX_PR',
          description: 'Apply null-safe optional chaining: req.body?.order?.items || req.body?.items || []',
          codePatch: '- const items = req.body.order.items;\n+ const items = req.body?.order?.items || req.body?.items || [];'
        },
        regressionTestSnippet: 'it("handles payloads missing outer order key", async () => { ... })'
      },
      actionsTaken: [
        {
          id: 'act-001',
          action: 'Created branch agent/fix-inc-001 and submitted PR #42 with regression test',
          tier: 'AUTO_FIX',
          executedBy: 'AI_AGENT',
          timestamp: t3,
          result: 'PR #42 merged by On-Call Dev'
        },
        {
          id: 'act-002',
          action: 'Post-fix verification: monitored error rate for 60s (recovered to 0.4%)',
          tier: 'AUTO_FIX',
          executedBy: 'AI_AGENT',
          timestamp: t4,
          result: 'Incident resolved successfully'
        }
      ],
      postmortem: `# Postmortem: INC-20261121-001
**Service**: Orders Service
**Impact**: Checkout failure rate spiked to 14.2% for ~100 seconds.
**Time to Diagnose**: 18 seconds (vs 15m manual baseline - 98% faster).
**Root Cause**: Unsafe property access in commit \`b83d10c\`.
**Fix**: PR #42 added null-safety and regression test.`
    };

    this.incidents.set(pastIncidentId, historicalIncident);
  }

  public hasActiveIncident(serviceId: string): boolean {
    return Array.from(this.incidents.values()).some(
      i => i.serviceId === serviceId && i.status !== 'RESOLVED' && i.status !== 'FAILED'
    );
  }

  public getActiveIncident(serviceId: string): Incident | undefined {
    return Array.from(this.incidents.values()).find(
      i => i.serviceId === serviceId && i.status !== 'RESOLVED' && i.status !== 'FAILED'
    );
  }

  /**
   * Evaluates incoming alarm evidence against existing active incident.
   * Suppresses duplicate AI invocations unless meaningful new evidence is detected.
   */
  public checkNewEvidence(
    serviceId: string, 
    ruleTriggered: string, 
    category: Incident['category'], 
    evidence: IncidentEvidence
  ): { incident: Incident; isNew: boolean; requiresReassessment: boolean } {
    const active = this.getActiveIncident(serviceId);
    if (!active) {
      const incident = this.createIncident(serviceId, ruleTriggered, category, evidence);
      return { incident, isNew: true, requiresReassessment: true };
    }

    // Meaningful new evidence criteria
    let hasNewStackTrace = false;
    let hasNewCommit = false;
    let hasStateChange = false;

    if (evidence.stackTrace && !active.evidence.stackTrace) {
      active.evidence.stackTrace = evidence.stackTrace;
      hasNewStackTrace = true;
    }
    if (evidence.suspectCommit && (!active.evidence.suspectCommit || active.evidence.suspectCommit.sha === 'HEAD')) {
      active.evidence.suspectCommit = evidence.suspectCommit;
      hasNewCommit = true;
    }
    if (evidence.containerState && (!active.evidence.containerState || active.evidence.containerState.status !== evidence.containerState.status)) {
      active.evidence.containerState = evidence.containerState;
      hasStateChange = true;
    }

    if (evidence.recentLogs && evidence.recentLogs.length > 0) {
      active.evidence.recentLogs = [
        ...active.evidence.recentLogs,
        ...evidence.recentLogs
      ].slice(-30);
    }

    const requiresReassessment = hasNewStackTrace || hasNewCommit || hasStateChange;

    active.actionsTaken.push({
      id: `act-${Date.now()}`,
      action: requiresReassessment 
        ? `Meaningful new evidence detected (${hasNewStackTrace ? 'New Stack Trace; ' : ''}${hasNewCommit ? 'New Commit; ' : ''}${hasStateChange ? 'State Change; ' : ''}): Triggering AI reassessment`
        : `Repeated alarm suppressed: ${ruleTriggered}`,
      tier: active.diagnosis?.safetyTier || 'AUTO_FIX',
      executedBy: 'AI_AGENT',
      timestamp: new Date().toISOString(),
      result: requiresReassessment ? 'Scheduled AI re-diagnosis' : 'Suppressed duplicate AI invocation'
    });

    return { incident: active, isNew: false, requiresReassessment };
  }

  public createIncident(
    serviceId: string, 
    ruleTriggered: string, 
    category: Incident['category'], 
    evidence: IncidentEvidence,
    severity: Incident['severity'] = 'CRITICAL'
  ): Incident {
    // Deduplication check: if an active incident already exists for this service, update it rather than spamming duplicates
    const active = this.getActiveIncident(serviceId);
    if (active) {
      if (evidence.recentLogs && evidence.recentLogs.length > 0) {
        active.evidence.recentLogs = [
          ...active.evidence.recentLogs,
          ...evidence.recentLogs
        ].slice(-30);
      }
      if (evidence.stackTrace && !active.evidence.stackTrace) {
        active.evidence.stackTrace = evidence.stackTrace;
      }
      active.actionsTaken.push({
        id: `act-${Date.now()}`,
        action: `Repeated alarm suppressed: ${ruleTriggered}`,
        tier: active.diagnosis?.safetyTier || 'AUTO_FIX',
        executedBy: 'AI_AGENT',
        timestamp: new Date().toISOString(),
        result: 'Appended telemetry to existing active incident to prevent alarm flood'
      });
      return active;
    }

    const id = `INC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(this.incidents.size + 1).padStart(3, '0')}`;
    const now = new Date().toISOString();

    const incident: Incident = {
      id,
      serviceId,
      title: `${serviceId.toUpperCase()}: ${ruleTriggered}`,
      ruleTriggered,
      category,
      status: 'DIAGNOSING',
      severity,
      timestamps: {
        faultStartedAt: new Date(Date.now() - 15000).toISOString(),
        alarmRaisedAt: now
      },
      evidence,
      actionsTaken: []
    };

    this.incidents.set(id, incident);
    return incident;
  }

  public setDiagnosis(id: string, diagnosis: IncidentDiagnosis): Incident | undefined {
    const incident = this.incidents.get(id);
    if (!incident) return undefined;

    const now = new Date();
    const alarmTime = new Date(incident.timestamps.alarmRaisedAt);
    const diagnosisTimeSeconds = Math.max(1, Math.round((now.getTime() - alarmTime.getTime()) / 1000));

    incident.diagnosis = diagnosis;
    incident.timestamps.causeNamedAt = now.toISOString();
    incident.timestamps.timeToDiagnosisSeconds = diagnosisTimeSeconds;

    // Transition status based on safety tier
    if (diagnosis.safetyTier === 'ASK_FIRST') {
      incident.status = 'WAITING_APPROVAL';
    } else {
      incident.status = 'RESOLVING';
    }

    return incident;
  }

  public recordAction(id: string, action: Omit<IncidentAction, 'id' | 'timestamp'>): IncidentAction | undefined {
    const incident = this.incidents.get(id);
    if (!incident) return undefined;

    const entry: IncidentAction = {
      id: `act-${Date.now()}`,
      timestamp: new Date().toISOString(),
      ...action
    };

    incident.actionsTaken.push(entry);
    return entry;
  }

  public resolveIncident(id: string, postmortemMarkdown?: string): Incident | undefined {
    const incident = this.incidents.get(id);
    if (!incident) return undefined;

    const now = new Date();
    const alarmTime = new Date(incident.timestamps.alarmRaisedAt);
    const recoverySeconds = Math.max(1, Math.round((now.getTime() - alarmTime.getTime()) / 1000));

    incident.status = 'RESOLVED';
    incident.timestamps.resolvedAt = now.toISOString();
    incident.timestamps.timeToRecoverySeconds = recoverySeconds;
    if (postmortemMarkdown) {
      incident.postmortem = postmortemMarkdown;
    }

    return incident;
  }

  public updateStatus(id: string, status: IncidentStatus): void {
    const incident = this.incidents.get(id);
    if (incident) {
      incident.status = status;
    }
  }

  public getById(id: string): Incident | undefined {
    return this.incidents.get(id);
  }

  public getAll(): Incident[] {
    return Array.from(this.incidents.values()).sort((a, b) => 
      new Date(b.timestamps.alarmRaisedAt).getTime() - new Date(a.timestamps.alarmRaisedAt).getTime()
    );
  }

  public recordDeployMarker(marker: Omit<DeployMarker, 'id'>): DeployMarker {
    const newMarker: DeployMarker = {
      id: `dep-${Date.now()}`,
      ...marker
    };
    this.deployMarkers.unshift(newMarker);
    if (this.deployMarkers.length > 50) {
      this.deployMarkers.pop();
    }
    return newMarker;
  }

  public getRecentDeployMarkers(serviceId?: string, windowMinutes: number = 15): DeployMarker[] {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    return this.deployMarkers.filter(m => {
      const matchService = serviceId ? m.serviceId === serviceId : true;
      const withinTime = new Date(m.timestamp).getTime() >= cutoff;
      return matchService && withinTime;
    });
  }

  public incrementBlockedThreats(): void {
    this.threatsBlockedCount++;
  }

  public getScorecard(): Scorecard {
    const all = Array.from(this.incidents.values());
    const diagnosed = all.filter(i => i.timestamps.timeToDiagnosisSeconds !== undefined);
    const fixed = all.filter(i => i.status === 'RESOLVED');

    const totalDiagnosisSec = diagnosed.reduce((acc, curr) => acc + (curr.timestamps.timeToDiagnosisSeconds || 0), 0);
    const avgMttd = diagnosed.length > 0 ? Math.round(totalDiagnosisSec / diagnosed.length) : 0;

    const manualSec = CONFIG.MANUAL_DIAGNOSIS_BASELINE_SEC;
    const timeSaved = diagnosed.reduce((acc, curr) => {
      const saved = manualSec - (curr.timestamps.timeToDiagnosisSeconds || 0);
      return acc + Math.max(0, saved);
    }, 0);

    return {
      totalIncidents: all.length,
      autoDiagnosed: diagnosed.length,
      autoFixed: fixed.length,
      avgTimeToDiagnosisSeconds: avgMttd,
      manualBaselineSeconds: manualSec,
      timeSavedSeconds: timeSaved,
      threatsBlockedBySietch: this.threatsBlockedCount
    };
  }
}

export const incidentManager = new IncidentManager();
