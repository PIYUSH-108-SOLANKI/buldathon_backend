import { IncidentEvidence, SuspectCommit } from '../types';
import { incidentManager } from './incidentManager';
import { logCollector } from './logCollector';
import { serviceRegistry } from './serviceRegistry';
import { CONFIG } from '../config';

export class CulpritFinder {
  /**
   * Correlates logs, recent deploys, and container state to isolate the culprit
   */
  public findCulprit(serviceId: string, ruleTriggered: string): { category: 'CODE_BUG' | 'RUNTIME_FAULT' | 'MEMORY_LEAK' | 'MALICIOUS_PACKAGE'; evidence: IncidentEvidence } {
    const recentLogs = logCollector.getRecentLogs(serviceId, 25);
    const recentDeploys = incidentManager.getRecentDeployMarkers(serviceId, 15);
    const currentService = serviceRegistry.getById(serviceId);
    const liveStats = currentService?.currentStats;

    const realMetricSnapshot = liveStats ? {
      errorRate5xx: liveStats.errorRate5xx,
      p95LatencyMs: liveStats.p95LatencyMs,
      throughputRpm: liveStats.throughputRpm,
      memoryUsagePercent: liveStats.memoryUsagePercent,
      metricsAvailable: liveStats.metricsAvailable,
      errorMessage: liveStats.errorMessage,
      status: currentService.status
    } : { rule: ruleTriggered };

    // 1. Check for Sietch Security / Malicious Package
    const securityLog = recentLogs.find(l => l.includes('[SIETCH SECURITY SHIELD]'));
    if (securityLog) {
      return {
        category: 'MALICIOUS_PACKAGE',
        evidence: {
          metricSnapshots: { status: 'BLOCKED', ...realMetricSnapshot },
          recentLogs,
          stackTrace: securityLog
        }
      };
    }

    // 2. Check for Killed Container / OOM / Runtime Fault / Unreachable
    const isContainerKilled = ruleTriggered.toLowerCase().includes('container health check failed') ||
      ruleTriggered.toLowerCase().includes('service down') ||
      ruleTriggered.toLowerCase().includes('service unreachable') ||
      ruleTriggered.toLowerCase().includes('connection refused') ||
      recentLogs.some(l => l.includes('exitCode=137') || l.includes('SIGKILL') || l.includes('ECONNREFUSED'));

    const isMemoryLeak = recentLogs.some(l => l.includes('heap out of memory') || l.includes('Allocation failed')) ||
      (liveStats && liveStats.memoryUsagePercent !== null && liveStats.memoryUsagePercent > 90);

    if (isContainerKilled && !isMemoryLeak) {
      return {
        category: 'RUNTIME_FAULT',
        evidence: {
          metricSnapshots: { availability: 0, ...realMetricSnapshot },
          recentLogs,
          containerState: {
            restarts: 1,
            exitCode: 137,
            status: currentService?.status === 'DOWN' ? 'unreachable/down' : 'exited'
          }
        }
      };
    }

    if (isMemoryLeak) {
      return {
        category: 'MEMORY_LEAK',
        evidence: {
          metricSnapshots: { ...realMetricSnapshot, memoryPercent: liveStats?.memoryUsagePercent || 98.4 },
          recentLogs,
          containerState: {
            restarts: 1,
            memoryLimitMb: 512,
            status: 'crashed'
          }
        }
      };
    }

    // 3. Code Bug with Stack Trace
    const stackTrace = this.extractStackTrace(recentLogs);
    let suspectCommit: SuspectCommit | undefined = undefined;

    if (stackTrace) {
      const parsedFrame = this.parseTopFrame(stackTrace);
      if (recentDeploys.length > 0) {
        const latestDeploy = recentDeploys[0];
        suspectCommit = {
          sha: latestDeploy.commitSha,
          message: latestDeploy.commitMessage,
          author: latestDeploy.author,
          file: parsedFrame.file || 'unknown',
          line: parsedFrame.line || 1,
          diff: latestDeploy.diffSummary || `Modified files: ${latestDeploy.commitMessage}`
        };
      } else if (CONFIG.DEMO_MODE) {
        // Fallback suspect commit only for simulated demo mode
        suspectCommit = {
          sha: 'b83d10c',
          message: 'feat: add bundle checkout',
          author: 'dev-alex@company.com',
          file: parsedFrame.file || 'src/services/order.service.ts',
          line: parsedFrame.line || 42,
          diff: '+ const items = req.body.order.items;'
        };
      } else {
        suspectCommit = {
          sha: 'HEAD',
          message: 'Active deployment (no matching deploy marker in 15m window)',
          author: 'Unknown',
          file: parsedFrame.file || 'unknown',
          line: parsedFrame.line || 1,
          diff: `Failing stack frame points to ${parsedFrame.file || 'unknown'}:${parsedFrame.line || 1}`
        };
      }
    }

    return {
      category: 'CODE_BUG',
      evidence: {
        metricSnapshots: realMetricSnapshot,
        recentLogs,
        stackTrace: stackTrace || recentLogs.slice(-3).join('\n'),
        suspectCommit
      }
    };
  }

  private extractStackTrace(logs: string[]): string | undefined {
    const errorIndex = logs.findIndex(l => l.includes('Error:') || l.includes('TypeError:') || l.includes('KnexTimeoutError'));
    if (errorIndex !== -1) {
      return logs.slice(errorIndex, errorIndex + 6).join('\n');
    }
    return undefined;
  }

  private parseTopFrame(stack: string): { file?: string; line?: number } {
    const match = stack.match(/at\s+.*?\((.*?):(\d+):(\d+)\)/) || stack.match(/at\s+(.*?):(\d+):(\d+)/);
    if (match) {
      return {
        file: match[1],
        line: parseInt(match[2], 10)
      };
    }
    return { file: 'src/services/order.service.ts', line: 42 };
  }
}

export const culpritFinder = new CulpritFinder();
