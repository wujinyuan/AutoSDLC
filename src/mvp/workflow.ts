import { createHash, randomUUID } from 'crypto';
import { access, lstat, mkdir, readFile, readlink, realpath } from 'fs/promises';
import os from 'os';
import path from 'path';
import { AgentRunner, CodexCliAgent } from './agent';
import { requireSuccess, runProcess } from './process';
import {
  CheckResult,
  ProjectProfile,
  ReviewResult,
  RunRecord,
  TaskInput,
} from './types';
import { RunStore } from './store';

const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'steps', 'expectedFiles', 'risks', 'verification'],
  properties: {
    summary: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    expectedFiles: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'string' } },
  },
};

const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'evidence', 'recommendation'],
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
          },
          title: { type: 'string' },
          evidence: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
  },
};

interface PlanResult {
  summary: string;
  steps: string[];
  expectedFiles: string[];
  risks: string[];
  verification: string[];
}

interface WorkflowOptions {
  projectPath: string;
  profilePath: string;
  stateDir?: string;
  agentFactory?: (profile: ProjectProfile, artifactDir: string) => AgentRunner;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function nulPaths(output: string): string[] {
  return output.split('\0').filter((item) => item.length > 0).map(toPosix);
}

function globMatches(file: string, pattern: string): boolean {
  const normalized = toPosix(pattern);
  let expression = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        expression += '(?:[\\s\\S]*/)?';
        index += 2;
      } else {
        expression += '[\\s\\S]*';
        index += 1;
      }
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(toPosix(file));
}

export function githubRepositoryFromRemote(remoteUrl: string): string | undefined {
  const scpStyle = remoteUrl.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpStyle) {
    return `${scpStyle[1]}/${scpStyle[2].replace(/\.git$/, '')}`;
  }
  try {
    const parsed = new URL(remoteUrl);
    if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol)) return undefined;
    const repositoryPath = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return repositoryPath ? `${parsed.hostname}/${repositoryPath}` : undefined;
  } catch {
    return undefined;
  }
}

function renderTask(task: TaskInput): string {
  const acceptance = task.acceptanceCriteria.map((item) => `- ${item}`).join('\n');
  const nonGoals = (task.nonGoals ?? []).map((item) => `- ${item}`).join('\n');
  return `# ${task.title}\n\n${task.description}\n\n## Acceptance criteria\n\n${acceptance}\n${
    nonGoals ? `\n## Non-goals\n\n${nonGoals}\n` : ''
  }`;
}

export class AutoSdlcWorkflow {
  private readonly projectPath: string;
  private readonly profilePath: string;
  private readonly stateDir: string;
  private readonly store: RunStore;
  private readonly agentFactory: (
    profile: ProjectProfile,
    artifactDir: string
  ) => AgentRunner;

  constructor(options: WorkflowOptions) {
    this.projectPath = path.resolve(options.projectPath);
    this.profilePath = path.resolve(options.profilePath);
    const projectKey = createHash('sha256').update(this.projectPath).digest('hex').slice(0, 10);
    this.stateDir = path.resolve(
      options.stateDir ?? path.join(os.homedir(), '.autosdlc', 'projects', projectKey)
    );
    this.store = new RunStore(this.stateDir);
    this.agentFactory =
      options.agentFactory ?? ((profile, artifactDir) => new CodexCliAgent(profile, artifactDir));
  }

  private async profile(): Promise<ProjectProfile> {
    const profile = JSON.parse(await readFile(this.profilePath, 'utf8')) as ProjectProfile;
    this.validateProfile(profile);
    return profile;
  }

  private validateProfile(profile: ProjectProfile): void {
    if (
      profile.version !== 1 ||
      !profile.name ||
      !profile.baseBranch ||
      !Array.isArray(profile.allowedPaths) ||
      profile.allowedPaths.length === 0 ||
      !Array.isArray(profile.checks) ||
      profile.checks.length === 0 ||
      (profile.verificationOutputPaths !== undefined &&
        !Array.isArray(profile.verificationOutputPaths))
    ) {
      throw new Error('Invalid project profile: version, name, baseBranch, allowedPaths and checks are required.');
    }
  }

  private async runProfile(record: RunRecord): Promise<ProjectProfile> {
    const raw = await readFile(this.store.artifactPath(record.id, 'profile.snapshot.json'), 'utf8');
    const profile = JSON.parse(raw) as ProjectProfile;
    this.validateProfile(profile);
    const actualHash = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
    if (actualHash !== record.profileHash) {
      throw new Error('Run profile snapshot does not match its recorded hash.');
    }
    return profile;
  }

  async start(task: TaskInput): Promise<RunRecord> {
    const profile = await this.profile();
    await access(this.projectPath);
    const root = (
      await requireSuccess('git', ['rev-parse', '--show-toplevel'], { cwd: this.projectPath })
    ).stdout.trim();
    if ((await realpath(root)) !== (await realpath(this.projectPath))) {
      throw new Error(`Project path must be the Git root: ${root}`);
    }
    const dirty = (
      await requireSuccess('git', ['status', '--porcelain'], {
        cwd: this.projectPath,
      })
    ).stdout.trim();
    if (dirty) throw new Error('Project worktree has tracked changes; commit or stash them before starting.');

    await requireSuccess('git', ['show-ref', '--verify', `refs/heads/${profile.baseBranch}`], {
      cwd: this.projectPath,
    });
    const baseSha = (
      await requireSuccess('git', ['rev-parse', profile.baseBranch], { cwd: this.projectPath })
    ).stdout.trim();
    const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const projectKey = createHash('sha256').update(this.projectPath).digest('hex').slice(0, 10);
    const worktreePath = path.join(os.tmpdir(), 'autosdlc-worktrees', projectKey, id);
    const branch = `autosdlc/${id}`;
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await requireSuccess('git', ['worktree', 'add', '-b', branch, worktreePath, baseSha], {
      cwd: this.projectPath,
    });

    const now = new Date().toISOString();
    const profileHash = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
    const record: RunRecord = {
      version: 1,
      id,
      projectPath: this.projectPath,
      profilePath: this.profilePath,
      profileHash,
      stateDir: this.stateDir,
      worktreePath,
      branch,
      baseBranch: profile.baseBranch,
      baseSha,
      status: 'PLANNING',
      task,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.initialize(record);
    await this.store.writeArtifact(
      id,
      'profile.snapshot.json',
      `${JSON.stringify(profile, null, 2)}\n`
    );
    await this.store.writeArtifact(id, 'task.md', renderTask(task));

    try {
      const agent = this.agentFactory(profile, this.store.runDir(id));
      const result = await agent.run({
        phase: 'plan',
        workspace: worktreePath,
        outputSchema: PLAN_SCHEMA,
        prompt: this.planPrompt(task, profile),
      });
      const plan = JSON.parse(result.output) as PlanResult;
      if (!Array.isArray(plan.expectedFiles) || plan.expectedFiles.length === 0) {
        throw new Error('Plan must declare at least one expected file.');
      }
      record.plan = result.output.trim();
      record.status = 'AWAITING_PLAN_APPROVAL';
      await this.store.writeArtifact(id, 'plan.json', `${record.plan}\n`);
      await this.store.save(record);
      await this.store.event(record, 'plan.proposed', { agentCommand: result.command });
      return record;
    } catch (error) {
      record.status = 'FAILED';
      record.error = error instanceof Error ? error.message : String(error);
      await this.store.save(record);
      await this.store.event(record, 'run.failed', { error: record.error });
      throw error;
    }
  }

  async continue(runId: string, approvePlan: boolean): Promise<RunRecord> {
    const record = await this.store.load(runId);
    const profile = await this.runProfile(record);
    if (record.projectPath !== this.projectPath || record.profilePath !== this.profilePath) {
      throw new Error('Run project/profile does not match the current command.');
    }
    await access(record.worktreePath);
    if (record.status === 'AWAITING_PLAN_APPROVAL' && !approvePlan) {
      throw new Error('Plan approval is required. Re-run with --approve-plan after reviewing plan.json.');
    }
    const previousStatus = record.status;
    const resumable = [
      'AWAITING_PLAN_APPROVAL',
      'IMPLEMENTING',
      'VERIFYING',
      'REVIEWING',
      'VERIFICATION_FAILED',
      'REVIEW_FAILED',
      'READY_FOR_PR',
      'FAILED',
    ];
    if (!resumable.includes(record.status)) {
      throw new Error(`Run cannot continue from status ${record.status}.`);
    }
    if (!record.plan) {
      throw new Error('Run has no approved plan and cannot continue. Start a new run.');
    }
    if (['IMPLEMENTING', 'VERIFYING', 'REVIEWING'].includes(previousStatus)) {
      record.error = `Recovered from an interrupted ${previousStatus} stage; replaying implementation and verification.`;
    }

    record.status = 'IMPLEMENTING';
    await this.store.save(record);
    await this.store.event(record, 'implementation.started', {
      approvedPlan: approvePlan,
      retryFrom: previousStatus,
    });
    if (previousStatus === 'AWAITING_PLAN_APPROVAL') {
      await this.store.event(record, 'plan.approved');
    }

    try {
      if (profile.setup && profile.setup.length > 0) {
        record.setupChecks = await this.runCommands(record, profile.setup);
        await this.store.writeArtifact(
          runId,
          'setup.json',
          `${JSON.stringify(record.setupChecks, null, 2)}\n`
        );
        const failedSetup = record.setupChecks.filter((check) => check.exitCode !== 0);
        if (failedSetup.length > 0) {
          record.status = 'FAILED';
          record.error = `${failedSetup.length} setup command(s) failed.`;
          await this.store.save(record);
          await this.store.event(record, 'setup.failed', {
            checks: failedSetup.map((check) => check.name),
          });
          return record;
        }
        await this.store.event(record, 'setup.completed', {
          checks: record.setupChecks.map((check) => check.name),
        });
      }
      const agent = this.agentFactory(profile, this.store.runDir(runId));
      const ignoredBeforeImplementation = await this.ignoredManifest(record);
      const implementation = await agent.run({
        phase: 'implement',
        workspace: record.worktreePath,
        prompt: this.implementationPrompt(record),
      });
      record.error = undefined;
      record.implementationSummary = implementation.output.trim();
      await this.store.writeArtifact(runId, 'implementation.md', implementation.output);

      const ignoredAfterImplementation = await this.ignoredManifest(record);
      const ignoredChanges = this.changedManifestPaths(
        ignoredBeforeImplementation,
        ignoredAfterImplementation
      );
      if (ignoredChanges.length > 0) {
        record.status = 'FAILED';
        record.error = `Implementation changed ignored paths: ${ignoredChanges.join(', ')}`;
        await this.store.save(record);
        await this.store.event(record, 'implementation.ignored_paths_changed', {
          changedPaths: ignoredChanges,
        });
        return record;
      }

      await this.enforceBaseHead(record);

      record.changedPaths = await this.changedPaths(record);
      if (record.changedPaths.length === 0) {
        record.status = 'FAILED';
        record.error = 'Implementation agent produced no repository changes.';
        await this.store.save(record);
        await this.store.event(record, 'implementation.no_changes');
        return record;
      }
      this.enforceScope(record.changedPaths, profile);
      this.enforcePlanScope(record.changedPaths, record);
      await this.store.event(record, 'implementation.completed', {
        changedPaths: record.changedPaths,
        agentCommand: implementation.command,
      });

      record.status = 'VERIFYING';
      await this.store.save(record);
      await requireSuccess('git', ['add', '-A'], { cwd: record.worktreePath });
      const verificationInputTree = (
        await requireSuccess('git', ['write-tree'], { cwd: record.worktreePath })
      ).stdout.trim();
      record.checks = await this.runCommands(record, profile.checks);
      await this.store.writeArtifact(runId, 'verification.json', `${JSON.stringify(record.checks, null, 2)}\n`);
      const failedChecks = record.checks.filter((check) => check.exitCode !== 0);
      if (failedChecks.length > 0) {
        record.status = 'VERIFICATION_FAILED';
        record.error = `${failedChecks.length} verification check(s) failed.`;
        await this.store.save(record);
        await this.store.event(record, 'verification.failed', {
          checks: failedChecks.map((check) => check.name),
        });
        return record;
      }
      await requireSuccess('git', ['add', '-A'], { cwd: record.worktreePath });
      const verificationOutputTree = (
        await requireSuccess('git', ['write-tree'], { cwd: record.worktreePath })
      ).stdout.trim();
      if (verificationOutputTree !== verificationInputTree) {
        record.status = 'VERIFICATION_FAILED';
        record.error = 'Verification commands changed repository content; checks must be non-mutating.';
        await this.store.save(record);
        await this.store.event(record, 'verification.mutated_tree', {
          inputTree: verificationInputTree,
          outputTree: verificationOutputTree,
        });
        return record;
      }
      const ignoredAfterVerification = await this.ignoredManifest(record);
      const unexpectedIgnoredOutputs = this.changedManifestPaths(
        ignoredAfterImplementation,
        ignoredAfterVerification
      ).filter(
        (file) =>
          !(profile.verificationOutputPaths ?? []).some((pattern) => globMatches(file, pattern))
      );
      if (unexpectedIgnoredOutputs.length > 0) {
        record.status = 'VERIFICATION_FAILED';
        record.error = `Verification changed undeclared ignored paths: ${unexpectedIgnoredOutputs.join(', ')}`;
        await this.store.save(record);
        await this.store.event(record, 'verification.ignored_paths_changed', {
          changedPaths: unexpectedIgnoredOutputs,
        });
        return record;
      }
      await this.store.event(record, 'verification.completed', {
        checks: record.checks.map((check) => check.name),
      });

      record.changedPaths = await this.changedPaths(record);
      this.enforceScope(record.changedPaths, profile);
      this.enforcePlanScope(record.changedPaths, record);
      await requireSuccess('git', ['add', '-A'], { cwd: record.worktreePath });
      record.reviewedTree = (
        await requireSuccess('git', ['write-tree'], { cwd: record.worktreePath })
      ).stdout.trim();

      record.status = 'REVIEWING';
      await this.store.save(record);
      const reviewOutput = await agent.run({
        phase: 'review',
        workspace: record.worktreePath,
        outputSchema: REVIEW_SCHEMA,
        prompt: this.reviewPrompt(record),
      });
      record.review = JSON.parse(reviewOutput.output) as ReviewResult;
      await this.store.writeArtifact(runId, 'review.json', `${JSON.stringify(record.review, null, 2)}\n`);
      const blockingFindings = record.review.findings.filter((finding) => finding.severity !== 'low');
      const reviewPassed = record.review.verdict === 'pass' && blockingFindings.length === 0;
      record.status = reviewPassed ? 'READY_FOR_PR' : 'REVIEW_FAILED';
      record.error = reviewPassed
        ? undefined
        : record.review.verdict === 'pass'
          ? 'Review returned pass with blocking findings; failing closed.'
          : 'Independent review requested changes.';
      await this.store.save(record);
      await this.store.event(record, 'review.completed', {
        verdict: record.review.verdict,
        findings: record.review.findings.length,
        agentCommand: reviewOutput.command,
      });
      return record;
    } catch (error) {
      record.status = 'FAILED';
      record.error = error instanceof Error ? error.message : String(error);
      await this.store.save(record);
      await this.store.event(record, 'run.failed', { error: record.error });
      throw error;
    }
  }

  async publish(runId: string): Promise<RunRecord> {
    const record = await this.store.load(runId);
    if (record.projectPath !== this.projectPath || record.profilePath !== this.profilePath) {
      throw new Error('Run project/profile does not match the current command.');
    }
    if (record.status !== 'READY_FOR_PR') {
      throw new Error(`Only READY_FOR_PR runs can be published; current status is ${record.status}.`);
    }

    // Any failure before this point completes invalidates the reviewed evidence. External
    // delivery failures happen afterward and remain retryable from READY_FOR_PR.
    record.status = 'REVIEW_FAILED';
    let profile: ProjectProfile;
    try {
      profile = await this.runProfile(record);
      await this.enforcePublishHead(record);
      record.changedPaths = await this.changedPaths(record);
      this.enforceScope(record.changedPaths, profile);
      this.enforcePlanScope(record.changedPaths, record);
      await this.enforceBranch(record);
      await requireSuccess('git', ['add', '-A'], { cwd: record.worktreePath });
      const currentTree = (
        await requireSuccess('git', ['write-tree'], { cwd: record.worktreePath })
      ).stdout.trim();
      if (!record.reviewedTree || currentTree !== record.reviewedTree) {
        record.status = 'REVIEW_FAILED';
        throw new Error('Worktree content changed after verification/review; run continue again.');
      }
      const dirty = (
        await requireSuccess('git', ['status', '--porcelain'], { cwd: record.worktreePath })
      ).stdout.trim();
      if (dirty) {
        await requireSuccess('git', ['commit', '-m', `feat: ${record.task.title}`], {
          cwd: record.worktreePath,
        });
      } else {
        const head = (
          await requireSuccess('git', ['rev-parse', 'HEAD'], { cwd: record.worktreePath })
        ).stdout.trim();
        if (head === record.baseSha) throw new Error('There are no changes to publish.');
      }
      await this.enforceBranch(record);
      const committedTree = (
        await requireSuccess('git', ['rev-parse', 'HEAD^{tree}'], { cwd: record.worktreePath })
      ).stdout.trim();
      const postCommitDirty = (
        await requireSuccess('git', ['status', '--porcelain'], { cwd: record.worktreePath })
      ).stdout.trim();
      if (committedTree !== record.reviewedTree || postCommitDirty) {
        throw new Error('Commit hooks changed the reviewed content; run continue again.');
      }
      record.commitSha = (
        await requireSuccess('git', ['rev-parse', 'HEAD'], { cwd: record.worktreePath })
      ).stdout.trim();
      record.status = 'READY_FOR_PR';
      record.error = undefined;
      await this.store.save(record);
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      await this.store.save(record);
      await this.store.event(record, 'publish.preflight_failed', { error: record.error });
      throw error;
    }

    try {
      const remote = profile.delivery?.remote ?? 'origin';
      const remoteUrl = (
        await requireSuccess('git', ['remote', 'get-url', remote], { cwd: record.worktreePath })
      ).stdout.trim();
      const repository = githubRepositoryFromRemote(remoteUrl);
      await requireSuccess('git', ['push', '-u', remote, `HEAD:refs/heads/${record.branch}`], {
        cwd: record.worktreePath,
        timeoutMs: 5 * 60 * 1000,
      });
      const repositoryArgs = repository ? ['--repo', repository] : [];
      const existing = await runProcess(
        'gh',
        ['pr', 'view', record.branch, ...repositoryArgs, '--json', 'url', '--jq', '.url'],
        { cwd: record.worktreePath, timeoutMs: 60_000 }
      );
      if (existing.exitCode === 0 && existing.stdout.trim()) {
        record.pullRequestUrl = existing.stdout.trim();
      } else {
        const bodyPath = this.store.artifactPath(runId, 'pull-request.md');
        await this.store.writeArtifact(runId, 'pull-request.md', this.pullRequestBody(record));
        const pr = await requireSuccess(
          'gh',
          [
            'pr',
            'create',
            '--draft',
            '--base',
            record.baseBranch,
            '--head',
            record.branch,
            ...repositoryArgs,
            '--title',
            record.task.title,
            '--body-file',
            bodyPath,
          ],
          { cwd: record.worktreePath, timeoutMs: 5 * 60 * 1000 }
        );
        record.pullRequestUrl = pr.stdout.trim();
      }
      record.status = 'PR_CREATED';
      record.error = undefined;
      await this.store.save(record);
      await this.store.event(record, 'pull_request.created', { url: record.pullRequestUrl });
      return record;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      await this.store.save(record);
      await this.store.event(record, 'publish.failed', { error: record.error });
      throw error;
    }
  }

  async status(runId: string): Promise<RunRecord> {
    return this.store.load(runId);
  }

  private planPrompt(task: TaskInput, profile: ProjectProfile): string {
    return [
      'You are the planning stage of an Auto SDLC workflow.',
      'Inspect the repository. Do not modify files.',
      'Produce only JSON matching the supplied schema.',
      'The implementation must stay inside the allowed paths and satisfy the acceptance criteria.',
      `Allowed paths: ${profile.allowedPaths.join(', ')}`,
      `Blocked paths: ${(profile.blockedPaths ?? []).join(', ') || '(none)'}`,
      '',
      renderTask(task),
    ].join('\n');
  }

  private implementationPrompt(record: RunRecord): string {
    const priorEvidence = record.error
      ? `\nPrevious attempt failed: ${record.error}\nVerification: ${JSON.stringify(record.checks ?? [])}\nReview: ${JSON.stringify(record.review ?? {})}`
      : '';
    return [
      'You are the implementation worker in an Auto SDLC workflow.',
      'Implement the approved task in this worktree. Modify real files and run focused checks as needed.',
      'Do not commit, push, create a pull request, or modify files outside the approved plan.',
      'Do not claim success without inspecting the resulting diff.',
      '',
      'TASK:',
      renderTask(record.task),
      '',
      'APPROVED PLAN:',
      record.plan ?? '',
      priorEvidence,
    ].join('\n');
  }

  private reviewPrompt(record: RunRecord): string {
    return [
      'You are an independent code reviewer. Do not modify files.',
      `Review all changes against base commit ${record.baseSha}.`,
      'Inspect the actual git diff and assess correctness, regressions, security, and test coverage.',
      'A passing build alone is not sufficient. Return fail for any actionable critical/high/medium issue.',
      'Produce only JSON matching the supplied schema.',
      '',
      'TASK:',
      renderTask(record.task),
      '',
      'APPROVED PLAN:',
      record.plan ?? '',
      '',
      'VERIFICATION RESULTS:',
      JSON.stringify(record.checks ?? [], null, 2),
    ].join('\n');
  }

  private async changedPaths(record: RunRecord): Promise<string[]> {
    const tracked = await requireSuccess(
      'git',
      ['diff', '--name-only', '-z', '--no-renames', record.baseSha, '--'],
      { cwd: record.worktreePath }
    );
    const untracked = await requireSuccess(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      { cwd: record.worktreePath }
    );
    return [...new Set([...nulPaths(tracked.stdout), ...nulPaths(untracked.stdout)])].sort();
  }

  private async ignoredManifest(record: RunRecord): Promise<Map<string, string>> {
    const ignored = await requireSuccess(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
      { cwd: record.worktreePath }
    );
    const manifest = new Map<string, string>();
    for (const relativePath of nulPaths(ignored.stdout).sort()) {
      const absolutePath = path.join(record.worktreePath, relativePath);
      const metadata = await lstat(absolutePath);
      const digest = createHash('sha256');
      if (metadata.isSymbolicLink()) {
        digest.update(`symlink\0${metadata.mode}\0`).update(await readlink(absolutePath));
      } else if (metadata.isFile()) {
        digest.update(`file\0${metadata.mode}\0`).update(await readFile(absolutePath));
      } else {
        digest.update(`other\0${metadata.mode}\0${metadata.size}`);
      }
      manifest.set(relativePath, digest.digest('hex'));
    }
    return manifest;
  }

  private changedManifestPaths(before: Map<string, string>, after: Map<string, string>): string[] {
    const paths = new Set([...before.keys(), ...after.keys()]);
    return [...paths].filter((item) => before.get(item) !== after.get(item)).sort();
  }

  private enforceScope(changedPaths: string[], profile: ProjectProfile): void {
    const violations = changedPaths.filter((file) => {
      const allowed = profile.allowedPaths.some((pattern) => globMatches(file, pattern));
      const blocked = (profile.blockedPaths ?? []).some((pattern) => globMatches(file, pattern));
      return !allowed || blocked;
    });
    if (violations.length > 0) {
      throw new Error(`Implementation changed paths outside the approved scope: ${violations.join(', ')}`);
    }
  }

  private enforcePlanScope(changedPaths: string[], record: RunRecord): void {
    const plan = JSON.parse(record.plan ?? '{}') as Partial<PlanResult>;
    if (!Array.isArray(plan.expectedFiles) || plan.expectedFiles.length === 0) {
      throw new Error('Approved plan has no expected file scope.');
    }
    const unexpected = changedPaths.filter(
      (file) => !plan.expectedFiles?.some((pattern) => globMatches(file, pattern))
    );
    if (unexpected.length > 0) {
      throw new Error(`Implementation changed files outside the approved plan: ${unexpected.join(', ')}`);
    }
  }

  private async enforceBranch(record: RunRecord): Promise<void> {
    const currentBranch = await requireSuccess('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: record.worktreePath,
    });
    if (currentBranch.stdout.trim() !== record.branch) {
      throw new Error(
        `Worktree branch changed: expected ${record.branch}, got ${currentBranch.stdout.trim()}.`
      );
    }
  }

  private async enforceBaseHead(record: RunRecord): Promise<void> {
    const head = (
      await requireSuccess('git', ['rev-parse', 'HEAD'], { cwd: record.worktreePath })
    ).stdout.trim();
    if (head !== record.baseSha) {
      throw new Error('Run branch contains commits created outside the controlled publish stage.');
    }
  }

  private async enforcePublishHead(record: RunRecord): Promise<void> {
    const head = (
      await requireSuccess('git', ['rev-parse', 'HEAD'], { cwd: record.worktreePath })
    ).stdout.trim();
    if (head !== record.baseSha && head !== record.commitSha) {
      throw new Error('Run branch contains commits created outside the controlled publish stage.');
    }
  }

  private async runCommands(record: RunRecord, commands: ProjectProfile['checks']): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const check of commands) {
      const result = await runProcess(check.command, check.args ?? [], {
        cwd: record.worktreePath,
        timeoutMs: check.timeoutMs ?? 10 * 60 * 1000,
      });
      results.push({ name: check.name, ...result });
    }
    return results;
  }

  private pullRequestBody(record: RunRecord): string {
    const checks = (record.checks ?? [])
      .map((check) => `- ${check.exitCode === 0 ? '[x]' : '[ ]'} ${check.name}`)
      .join('\n');
    return `## AutoSDLC run\n\nRun: \`${record.id}\`\nBase: \`${record.baseSha}\`\n\n## Task\n\n${
      record.task.description
    }\n\n## Verification\n\n${checks}\n\n## Independent review\n\n${
      record.review?.summary ?? 'Not available'
    }\n`;
  }
}
