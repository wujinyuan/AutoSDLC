export type RunStatus =
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'IMPLEMENTING'
  | 'VERIFYING'
  | 'VERIFICATION_FAILED'
  | 'REVIEWING'
  | 'REVIEW_FAILED'
  | 'READY_FOR_PR'
  | 'PR_CREATED'
  | 'FAILED';

export interface CommandSpec {
  name: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface ProjectProfile {
  version: 1;
  name: string;
  baseBranch: string;
  allowedPaths: string[];
  blockedPaths?: string[];
  setup?: CommandSpec[];
  checks: CommandSpec[];
  verificationOutputPaths?: string[];
  agent?: {
    executable?: string;
    args?: string[];
    model?: string;
  };
  delivery?: {
    remote?: string;
  };
}

export interface TaskInput {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  nonGoals?: string[];
}

export interface AgentRequest {
  phase: 'plan' | 'implement' | 'review';
  workspace: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
}

export interface AgentResult {
  output: string;
  command: string[];
}

export interface CheckResult {
  name: string;
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ReviewResult {
  verdict: 'pass' | 'fail';
  summary: string;
  findings: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    title: string;
    evidence: string;
    recommendation: string;
  }>;
}

export interface RunRecord {
  version: 1;
  id: string;
  projectPath: string;
  profilePath: string;
  profileHash: string;
  stateDir: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  status: RunStatus;
  task: TaskInput;
  plan?: string;
  implementationSummary?: string;
  changedPaths?: string[];
  setupChecks?: CheckResult[];
  checks?: CheckResult[];
  review?: ReviewResult;
  reviewedTree?: string;
  commitSha?: string;
  pullRequestUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunEvent {
  timestamp: string;
  runId: string;
  type: string;
  status: RunStatus;
  details?: Record<string, unknown>;
}
