export type ServiceHealthStatus = 'HEALTHY' | 'WARNING' | 'DEGRADED' | 'DOWN';

export interface ConnectedApplication {
  id: string;
  name: string;
  type: 'frontend' | 'backend' | 'fullstack' | 'microservice';
  deployedUrl: string;
  healthEndpoint: string;
  metricsEndpoint?: string;
  repoUrl?: string;
  webhookUrl: string;
  webhookToken: string;
  status: ServiceHealthStatus;
  uptimePercent: number;
  lastProbe: {
    timestamp: string;
    statusCode: number;
    latencyMs: number;
    message: string;
  };
  createdAt: string;
}

export interface ServiceStats {
  errorRate5xx: number | null; // null when metrics unavailable / service offline (never fabricated 1.0)
  p95LatencyMs: number | null; // null when metrics unavailable
  throughputRpm: number | null;
  ordersRpm?: number | null; // Verified business metric: completed orders/checkouts per minute
  memoryUsagePercent: number | null;
  cpuPercent: number | null;
  metricsAvailable?: boolean; // false when metrics endpoint could not be reached or parsed
  errorMessage?: string; // actual HTTP / connection error details
  preCrashWarning?: string; // Predictive early warning
  businessMetricDrop?: boolean; // Flagged when silent throughput drop occurs despite 200 OK
}

export interface MonitoredService {
  id: string; // e.g. "gateway-service", "orders-service", "payments-service"
  name: string;
  repo: string;
  metricsUrl: string; // Direct /metrics endpoint or Prometheus query target
  grafanaUrl?: string; // Optional Grafana dashboard link/embed
  healthUrl: string;
  containerName: string;
  dependencies?: string[]; // IDs of services this service calls/depends on
  baselineThroughputRpm?: number; // Calibrated business baseline for throughput drop detection (e.g. 100 RPM)
  status: ServiceHealthStatus;
  lastCheck: string;
  currentVersion: string; // Active commit SHA or tag
  currentStats: ServiceStats;
  history: Array<{
    timestamp: string;
    stats: ServiceStats;
    status: ServiceHealthStatus;
  }>;
}

export interface DeployMarker {
  id: string;
  serviceId: string;
  commitSha: string;
  commitMessage: string;
  author: string;
  timestamp: string;
  environment: string;
  diffSummary?: string;
}

export type SafetyTier = 'AUTO_FIX' | 'ASK_FIRST' | 'NEVER_DO';

export type IncidentCategory = 'CODE_BUG' | 'RUNTIME_FAULT' | 'MEMORY_LEAK' | 'MALICIOUS_PACKAGE';

export type IncidentStatus = 
  | 'DETECTED' 
  | 'DIAGNOSING' 
  | 'WAITING_APPROVAL' 
  | 'EXECUTING'
  | 'RESOLVING' 
  | 'VERIFYING' 
  | 'RESOLVED' 
  | 'FAILED';

export interface SuspectCommit {
  sha: string;
  message: string;
  author: string;
  file: string;
  line: number;
  diff?: string;
}

export interface VerificationCheck {
  check: string;
  status: 'PASSED' | 'FAILED';
  detail: string;
  timestamp: string;
  targetServiceId?: string;
}

export interface IncidentEvidence {
  metricSnapshots: Record<string, any>;
  recentLogs: string[];
  stackTrace?: string;
  suspectCommit?: SuspectCommit;
  containerState?: {
    restarts: number;
    exitCode?: number;
    memoryLimitMb?: number;
    status: string;
  };
  dependencyTopology?: {
    serviceId: string;
    dependencies: string[];
    dependents: string[];
  };
  missingEvidence?: string[];
  verificationEvidence?: {
    startedAt: string;
    completedAt?: string;
    checks: VerificationCheck[];
  };
}

export type DiagnosisSource = 'AI_GEMINI' | 'DETERMINISTIC_HEURISTIC';

export type RecoveryActionType = 
  | 'FIX_PR' 
  | 'REVERT_PR' 
  | 'DOCKER_RESTART' 
  | 'SCALE_SERVICE' 
  | 'CIRCUIT_BREAKER_TRIP' 
  | 'CIRCUIT_BREAKER_RESET' 
  | 'REDUCE_RETRIES' 
  | 'ESCALATE_TO_HUMAN' 
  | 'MANUAL_INSTRUCTION';

export interface CounterfactualEvaluation {
  strategyName: string;
  actionType: RecoveryActionType;
  expectedBenefit: string;
  riskOfWorsening: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  cascadingRisk: string; // Impact on upstream callers / downstream dependencies
  reversibility: 'IMMEDIATE' | 'MODERATE' | 'IRREVERSIBLE';
  requiredAuthorization: SafetyTier;
  executionFeasibility: boolean; // Whether backend has an approved adapter to execute this
  counterfactualReasoning: string; // Explicit reasoning: What happens if executed vs alternative
  heuristicScore: number; // 0-100 risk-adjusted priority score
  targetService?: string;
  parameters?: Record<string, any>;
}

export interface RecoveryStrategy {
  name: string;
  description: string;
  actionType: RecoveryActionType;
  tier: SafetyTier;
  risks: string;
  command?: string;
  codePatch?: string;
  undoAction?: string;
  targetService?: string;
  parameters?: Record<string, any>;
}

export interface SuggestedFix {
  actionType: RecoveryActionType;
  description: string;
  codePatch?: string;
  command?: string;
  undoAction?: string;
  risks?: string;
  targetService?: string;
  parameters?: Record<string, any>;
}

export interface IncidentDiagnosis {
  diagnosisSource: DiagnosisSource; // Clearly label AI-generated vs deterministic fallback
  modelUsed?: string;              // Model identifier (e.g. "gemini-2.5-flash")
  summary: string;                 // High-level incident summary
  rootCause: string;               // Probable root cause
  evidence: string[];              // Array of concrete supporting evidence items
  confidence: number;              // 0.0 to 1.0
  uncertainty?: string;            // Confidence factors and uncertainty notes
  blastRadius: string;             // Potential blast radius assessment
  recoveryStrategies: RecoveryStrategy[]; // Structured recovery options with risk assessment
  counterfactualEvaluations?: CounterfactualEvaluation[]; // Evidence-based counterfactual reasoning per strategy
  recommendedStrategyIndex?: number; // Selected strategy index
  selectedStrategyRationale?: string; // Why this strategy was chosen over alternatives
  missingEvidenceNotes?: string[]; // Unknowns, unmeasured dependencies, or missing telemetry
  isCascadingFailure?: boolean;    // Whether a cascading retry storm / failure was detected
  explanation: string;             // Backwards-compatible detailed explanation
  safetyTier: SafetyTier;          // Validated safety tier (AUTO_FIX, ASK_FIRST, NEVER_DO)
  suggestedFix: SuggestedFix;      // Primary suggested remediation
  regressionTestSnippet?: string;
}

export interface IncidentAction {
  id: string;
  action: string;
  tier: SafetyTier;
  executedBy: 'AI_AGENT' | 'HUMAN_OPERATOR';
  timestamp: string;
  result: string;
}

export interface Incident {
  id: string;
  serviceId: string;
  title: string;
  ruleTriggered: string;
  category: IncidentCategory;
  status: IncidentStatus;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  timestamps: {
    faultStartedAt: string; // T0
    alarmRaisedAt: string;  // T1
    causeNamedAt?: string;  // T2
    fixAppliedAt?: string;  // T3
    resolvedAt?: string;    // T4
    timeToDiagnosisSeconds?: number; // T2 - T1
    timeToRecoverySeconds?: number;  // T4 - T1
  };
  evidence: IncidentEvidence;
  diagnosis?: IncidentDiagnosis;
  actionsTaken: IncidentAction[];
  postmortem?: string;
}

export interface Scorecard {
  totalIncidents: number;
  autoDiagnosed: number;
  autoFixed: number;
  avgTimeToDiagnosisSeconds: number;
  manualBaselineSeconds: number; // e.g. 900 seconds (15 minutes)
  timeSavedSeconds: number;
  threatsBlockedBySietch: number;
}
