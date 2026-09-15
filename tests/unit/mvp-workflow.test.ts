import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { AgentRunner } from '../../src/mvp/agent';
import { requireSuccess } from '../../src/mvp/process';
import { AgentRequest, ProjectProfile, TaskInput } from '../../src/mvp/types';
import { AutoSdlcWorkflow, githubRepositoryFromRemote } from '../../src/mvp/workflow';

class FakeAgent implements AgentRunner {
  constructor(private readonly reviewVerdict: 'pass' | 'fail' = 'pass') {}

  async run(request: AgentRequest): Promise<{ output: string; command: string[] }> {
    if (request.phase === 'plan') {
      return {
        output: JSON.stringify({
          summary: 'Add the requested value file.',
          steps: ['Create src/value.txt'],
          expectedFiles: ['src/value.txt'],
          risks: [],
          verification: ['check-value'],
        }),
        command: ['fake-agent', 'plan'],
      };
    }
    if (request.phase === 'implement') {
      await mkdir(path.join(request.workspace, 'src'), { recursive: true });
      await writeFile(path.join(request.workspace, 'src', 'value.txt'), 'ready\n', 'utf8');
      return { output: 'Implemented src/value.txt.', command: ['fake-agent', 'implement'] };
    }
    return {
      output: JSON.stringify({
        verdict: this.reviewVerdict,
        summary: this.reviewVerdict === 'pass' ? 'Change satisfies the task.' : 'Change needs work.',
        findings:
          this.reviewVerdict === 'pass'
            ? []
            : [
                {
                  severity: 'medium',
                  title: 'Example finding',
                  evidence: 'src/value.txt',
                  recommendation: 'Correct the value.',
                },
              ],
      }),
      command: ['fake-agent', 'review'],
    };
  }
}

describe('AutoSdlcWorkflow MVP', () => {
  let temporaryRoot: string;
  let projectPath: string;
  let profilePath: string;
  let profile: ProjectProfile;
  const task: TaskInput = {
    title: 'Create a verified value',
    description: 'Create src/value.txt containing ready.',
    acceptanceCriteria: ['src/value.txt exists', 'Its content is ready'],
  };

  test('resolves GitHub HTTPS and SSH remotes for explicit gh targeting', () => {
    expect(githubRepositoryFromRemote('git@github.com:wujinyuan/AutoSDLC.git')).toBe(
      'github.com/wujinyuan/AutoSDLC'
    );
    expect(githubRepositoryFromRemote('https://github.example.test/acme/project.git')).toBe(
      'github.example.test/acme/project'
    );
    expect(githubRepositoryFromRemote('/tmp/remote.git')).toBeUndefined();
  });

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'autosdlc-mvp-test-'));
    projectPath = path.join(temporaryRoot, 'project');
    profilePath = path.join(temporaryRoot, 'profile.json');
    await mkdir(projectPath);
    await requireSuccess('git', ['init', '-b', 'main'], { cwd: projectPath });
    await requireSuccess('git', ['config', 'user.name', 'AutoSDLC Test'], { cwd: projectPath });
    await requireSuccess('git', ['config', 'user.email', 'autosdlc@example.test'], {
      cwd: projectPath,
    });
    await writeFile(path.join(projectPath, 'README.md'), '# Fixture\n', 'utf8');
    await requireSuccess('git', ['add', 'README.md'], { cwd: projectPath });
    await requireSuccess('git', ['commit', '-m', 'fixture'], { cwd: projectPath });
    profile = {
      version: 1,
      name: 'fixture',
      baseBranch: 'main',
      allowedPaths: ['src/**'],
      checks: [
        {
          name: 'check-value',
          command: 'node',
          args: [
            '-e',
            "const fs=require('fs');if(fs.readFileSync('src/value.txt','utf8')!=='ready\\n')process.exit(1)",
          ],
        },
      ],
    };
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');
  });

  afterEach(async () => {
    const worktrees = await requireSuccess('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectPath,
    });
    const canonicalProject = await realpath(projectPath);
    const linked = worktrees.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .filter((worktree) => path.resolve(worktree) !== path.resolve(canonicalProject));
    for (const worktree of linked) {
      await requireSuccess('git', ['worktree', 'remove', '--force', worktree], { cwd: projectPath });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  test('runs an approved task through real Git isolation and verification', async () => {
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });

    const planned = await workflow.start(task);
    expect(planned.status).toBe('AWAITING_PLAN_APPROVAL');
    expect(planned.branch).toMatch(/^autosdlc\//);
    expect(await readFile(path.join(projectPath, 'README.md'), 'utf8')).toBe('# Fixture\n');

    // A mutable external profile cannot weaken or replace the run's bound checks.
    profile.checks[0].args = ['-e', 'process.exit(9)'];
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');

    const completed = await workflow.continue(planned.id, true);
    expect(completed.status).toBe('READY_FOR_PR');
    expect(completed.changedPaths).toEqual(['src/value.txt']);
    expect(completed.checks?.[0].exitCode).toBe(0);
    expect(completed.review?.verdict).toBe('pass');
    expect(await readFile(path.join(completed.worktreePath, 'src/value.txt'), 'utf8')).toBe(
      'ready\n'
    );
    const events = await readFile(
      path.join(temporaryRoot, 'state', 'runs', completed.id, 'events.jsonl'),
      'utf8'
    );
    expect(events).toContain('plan.proposed');
    expect(events).toContain('verification.completed');
    expect(events).toContain('review.completed');
  });

  test('supports globstar matching zero directory levels', async () => {
    profile.allowedPaths = ['**/*.txt'];
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const parsedPlan = JSON.parse(planned.plan ?? '{}');
    parsedPlan.expectedFiles = ['src/**/value.txt'];
    planned.plan = JSON.stringify(parsedPlan);
    await writeFile(
      path.join(temporaryRoot, 'state', 'runs', planned.id, 'run.json'),
      JSON.stringify(planned),
      'utf8'
    );
    expect((await workflow.continue(planned.id, true)).status).toBe('READY_FOR_PR');
  });

  test('does not implement before explicit plan approval', async () => {
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    await expect(workflow.continue(planned.id, false)).rejects.toThrow('Plan approval is required');
  });

  test('rejects a profile without deterministic verification checks', async () => {
    profile.checks = [];
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    await expect(workflow.start(task)).rejects.toThrow('Invalid project profile');
  });

  test('stops when deterministic verification fails', async () => {
    profile.checks[0].args = ['-e', 'process.exit(7)'];
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    expect(completed.status).toBe('VERIFICATION_FAILED');
    expect(completed.checks?.[0].exitCode).toBe(7);
    expect(completed.review).toBeUndefined();
  });

  test('rejects successful verification commands that mutate the reviewed tree', async () => {
    profile.checks = [
      {
        name: 'mutating-check',
        command: 'node',
        args: [
          '-e',
          "require('fs').writeFileSync('src/value.txt', 'changed-by-check\\n')",
        ],
      },
    ];
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    expect(completed.status).toBe('VERIFICATION_FAILED');
    expect(completed.error).toContain('checks must be non-mutating');
    expect(completed.review).toBeUndefined();
  });

  test('rejects a blocked rename even when its destination is allowed by the plan', async () => {
    await mkdir(path.join(projectPath, 'blocked'));
    await writeFile(path.join(projectPath, 'blocked', 'secret.txt'), 'secret\n', 'utf8');
    await requireSuccess('git', ['add', 'blocked/secret.txt'], { cwd: projectPath });
    await requireSuccess('git', ['commit', '-m', 'add blocked fixture'], { cwd: projectPath });
    profile.allowedPaths = ['allowed/**'];
    profile.blockedPaths = ['blocked/**'];
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');
    const renameAgent: AgentRunner = {
      async run(request) {
        if (request.phase === 'plan') {
          return {
            output: JSON.stringify({
              summary: 'Move fixture.',
              steps: ['Move the file'],
              expectedFiles: ['allowed/secret.txt'],
              risks: [],
              verification: [],
            }),
            command: ['fake-agent', 'plan'],
          };
        }
        if (request.phase === 'implement') {
          await mkdir(path.join(request.workspace, 'allowed'));
          await rename(
            path.join(request.workspace, 'blocked', 'secret.txt'),
            path.join(request.workspace, 'allowed', 'secret.txt')
          );
          return { output: 'Moved.', command: ['fake-agent', 'implement'] };
        }
        return {
          output: JSON.stringify({ verdict: 'pass', summary: 'Pass.', findings: [] }),
          command: ['fake-agent', 'review'],
        };
      },
    };
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => renameAgent,
    });
    const planned = await workflow.start(task);
    await expect(workflow.continue(planned.id, true)).rejects.toThrow(
      'outside the approved scope: blocked/secret.txt'
    );
    expect((await workflow.status(planned.id)).status).toBe('FAILED');
  });

  test('rejects an allowed path that was not part of the approved plan', async () => {
    const extraFileAgent: AgentRunner = {
      async run(request) {
        if (request.phase === 'plan') return new FakeAgent().run(request);
        if (request.phase === 'implement') {
          await mkdir(path.join(request.workspace, 'src'), { recursive: true });
          await writeFile(path.join(request.workspace, 'src', 'value.txt'), 'ready\n', 'utf8');
          await writeFile(path.join(request.workspace, 'src', 'extra.txt'), 'unexpected\n', 'utf8');
          return { output: 'Implemented with an extra file.', command: ['fake-agent', 'implement'] };
        }
        return new FakeAgent().run(request);
      },
    };
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => extraFileAgent,
    });
    const planned = await workflow.start(task);
    await expect(workflow.continue(planned.id, true)).rejects.toThrow(
      'outside the approved plan: src/extra.txt'
    );
  });

  test('rejects implementation changes to ignored files', async () => {
    await writeFile(path.join(projectPath, '.gitignore'), '.env\n', 'utf8');
    await requireSuccess('git', ['add', '.gitignore'], { cwd: projectPath });
    await requireSuccess('git', ['commit', '-m', 'ignore environment file'], { cwd: projectPath });
    const ignoredFileAgent: AgentRunner = {
      async run(request) {
        if (request.phase === 'implement') {
          await new FakeAgent().run(request);
          await writeFile(path.join(request.workspace, '.env'), 'SECRET=unexpected\n', 'utf8');
          return { output: 'Implemented with ignored state.', command: ['fake-agent', 'implement'] };
        }
        return new FakeAgent().run(request);
      },
    };
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => ignoredFileAgent,
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    expect(completed.status).toBe('FAILED');
    expect(completed.error).toContain('Implementation changed ignored paths: .env');
  });

  test('detects mode-only changes to an existing ignored file', async () => {
    await writeFile(path.join(projectPath, '.gitignore'), '.env\n', 'utf8');
    await requireSuccess('git', ['add', '.gitignore'], { cwd: projectPath });
    await requireSuccess('git', ['commit', '-m', 'ignore environment file'], { cwd: projectPath });
    profile.setup = [
      {
        name: 'fixture-env',
        command: 'node',
        args: ['-e', "require('fs').writeFileSync('.env', 'stable\\n', {mode: 0o600})"],
      },
    ];
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');
    const modeChangingAgent: AgentRunner = {
      async run(request) {
        const result = await new FakeAgent().run(request);
        if (request.phase === 'implement') await chmod(path.join(request.workspace, '.env'), 0o700);
        return result;
      },
    };
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => modeChangingAgent,
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    expect(completed.status).toBe('FAILED');
    expect(completed.error).toContain('Implementation changed ignored paths: .env');
  });

  test('requires ignored verification outputs to be declared', async () => {
    await writeFile(path.join(projectPath, '.gitignore'), 'generated.log\n', 'utf8');
    await requireSuccess('git', ['add', '.gitignore'], { cwd: projectPath });
    await requireSuccess('git', ['commit', '-m', 'ignore generated output'], { cwd: projectPath });
    profile.checks.push({
      name: 'generate-output',
      command: 'node',
      args: ['-e', "require('fs').writeFileSync('generated.log', 'evidence\\n')"],
    });
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    expect(completed.status).toBe('VERIFICATION_FAILED');
    expect(completed.error).toContain('undeclared ignored paths: generated.log');
  });

  test('rejects commits created by the implementation agent', async () => {
    const committingAgent: AgentRunner = {
      async run(request) {
        const result = await new FakeAgent().run(request);
        if (request.phase === 'implement') {
          await requireSuccess('git', ['add', '-A'], { cwd: request.workspace });
          await requireSuccess('git', ['commit', '-m', 'uncontrolled commit'], {
            cwd: request.workspace,
          });
        }
        return result;
      },
    };
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => committingAgent,
    });
    const planned = await workflow.start(task);
    await expect(workflow.continue(planned.id, true)).rejects.toThrow(
      'commits created outside the controlled publish stage'
    );
  });

  test('rejects a commit added after review and before publication', async () => {
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    await requireSuccess('git', ['commit', '-m', 'uncontrolled reviewed commit'], {
      cwd: completed.worktreePath,
    });
    await expect(workflow.publish(completed.id)).rejects.toThrow(
      'commits created outside the controlled publish stage'
    );
    expect((await workflow.status(completed.id)).status).toBe('REVIEW_FAILED');
  });

  test('accepts non-ASCII and newline paths without Git quote escaping', async () => {
    profile.allowedPaths = ['Docs/**'];
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');
    const unicodePath = 'Docs/说明\n详情.md';
    const unicodeTask = { ...task, acceptanceCriteria: [`${unicodePath} exists`] };
    const unicodeAgent: AgentRunner = {
      async run(request) {
        if (request.phase === 'plan') {
          return {
            output: JSON.stringify({
              summary: 'Add documentation.',
              steps: [`Create ${unicodePath}`],
              expectedFiles: ['Docs/**'],
              risks: [],
              verification: ['check-value'],
            }),
            command: ['fake-agent', 'plan'],
          };
        }
        if (request.phase === 'implement') {
          await mkdir(path.join(request.workspace, 'Docs'));
          await writeFile(path.join(request.workspace, unicodePath), 'ready\n', 'utf8');
          return { output: 'Added documentation.', command: ['fake-agent', 'implement'] };
        }
        return new FakeAgent().run(request);
      },
    };
    profile.checks[0].args = [
      '-e',
      `if(require('fs').readFileSync(${JSON.stringify(unicodePath)},'utf8')!=='ready\\n')process.exit(1)`,
    ];
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => unicodeAgent,
    });
    const planned = await workflow.start(unicodeTask);
    const completed = await workflow.continue(planned.id, true);
    expect(completed.status).toBe('READY_FOR_PR');
    expect(completed.changedPaths).toEqual([unicodePath]);
  });

  test('refuses publication when reviewed content changes', async () => {
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    await writeFile(path.join(completed.worktreePath, 'src', 'value.txt'), 'changed\n', 'utf8');
    await expect(workflow.publish(completed.id)).rejects.toThrow(
      'Worktree content changed after verification/review'
    );
    expect((await workflow.status(completed.id)).status).toBe('REVIEW_FAILED');
    expect((await workflow.continue(completed.id, false)).status).toBe('READY_FOR_PR');
  });

  test('persists a failed review state for out-of-scope changes before publication', async () => {
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    await writeFile(path.join(completed.worktreePath, 'README.md'), 'out of scope\n', 'utf8');
    await expect(workflow.publish(completed.id)).rejects.toThrow('outside the approved scope');
    expect((await workflow.status(completed.id)).status).toBe('REVIEW_FAILED');
  });

  test('rejects publication through a workflow configured for another project', async () => {
    const stateDir = path.join(temporaryRoot, 'state');
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir,
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    const otherWorkflow = new AutoSdlcWorkflow({
      projectPath: path.join(temporaryRoot, 'different-project'),
      profilePath,
      stateDir,
      agentFactory: () => new FakeAgent(),
    });
    await expect(otherWorkflow.publish(completed.id)).rejects.toThrow(
      'Run project/profile does not match'
    );
    expect((await workflow.status(completed.id)).status).toBe('READY_FOR_PR');
  });

  test('persists REVIEW_FAILED when the bound profile snapshot is invalid', async () => {
    const stateDir = path.join(temporaryRoot, 'state');
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir,
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    await writeFile(
      path.join(stateDir, 'runs', completed.id, 'profile.snapshot.json'),
      JSON.stringify({ ...profile, allowedPaths: ['**'] }),
      'utf8'
    );
    await expect(workflow.publish(completed.id)).rejects.toThrow('recorded hash');
    expect((await workflow.status(completed.id)).status).toBe('REVIEW_FAILED');
  });

  test('fails closed when a passing review contains a blocking finding', async () => {
    const contradictoryReviewer: AgentRunner = {
      async run(request) {
        if (request.phase !== 'review') return new FakeAgent().run(request);
        return {
          output: JSON.stringify({
            verdict: 'pass',
            summary: 'Contradictory review.',
            findings: [
              {
                severity: 'high',
                title: 'Blocking issue',
                evidence: 'src/value.txt',
                recommendation: 'Fix it.',
              },
            ],
          }),
          command: ['fake-agent', 'review'],
        };
      },
    };
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => contradictoryReviewer,
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    expect(completed.status).toBe('REVIEW_FAILED');
    expect(completed.error).toContain('failing closed');
  });

  test('rejects content changed by a pre-commit hook', async () => {
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    const hook = path.join(projectPath, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hook,
      "#!/bin/sh\nprintf 'hook-change\\n' > src/value.txt\ngit add src/value.txt\n",
      'utf8'
    );
    await chmod(hook, 0o755);
    await expect(workflow.publish(completed.id)).rejects.toThrow(
      'Commit hooks changed the reviewed content'
    );
    expect((await workflow.status(completed.id)).status).toBe('REVIEW_FAILED');
  });

  test('rejects a worktree switched to another branch before publication', async () => {
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    await requireSuccess('git', ['switch', '-c', 'unexpected-branch'], {
      cwd: completed.worktreePath,
    });
    await expect(workflow.publish(completed.id)).rejects.toThrow('Worktree branch changed');
  });

  test('commits the reviewed tree, pushes the exact run branch, and records a draft PR', async () => {
    const bareRemote = path.join(temporaryRoot, 'remote.git');
    const fakeBin = path.join(temporaryRoot, 'bin');
    await mkdir(fakeBin);
    await requireSuccess('git', ['init', '--bare', bareRemote], { cwd: temporaryRoot });
    await requireSuccess('git', ['remote', 'add', 'origin', bareRemote], { cwd: projectPath });
    const fakeGh = path.join(fakeBin, 'gh');
    await writeFile(
      fakeGh,
      "#!/bin/sh\nif [ \"$2\" = \"view\" ]; then exit 1; fi\nprintf '%s\\n' 'https://example.test/pull/1'\n",
      'utf8'
    );
    await chmod(fakeGh, 0o755);
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir: path.join(temporaryRoot, 'state'),
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const completed = await workflow.continue(planned.id, true);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`;
    try {
      const published = await workflow.publish(completed.id);
      expect(published.status).toBe('PR_CREATED');
      expect(published.pullRequestUrl).toBe('https://example.test/pull/1');
      const remote = await requireSuccess(
        'git',
        ['ls-remote', '--heads', 'origin', `refs/heads/${published.branch}`],
        { cwd: projectPath }
      );
      expect(remote.stdout).toContain(`refs/heads/${published.branch}`);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('replays an interrupted active state', async () => {
    const stateDir = path.join(temporaryRoot, 'state');
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir,
      agentFactory: () => new FakeAgent(),
    });
    const planned = await workflow.start(task);
    const runPath = path.join(stateDir, 'runs', planned.id, 'run.json');
    const interrupted = JSON.parse(await readFile(runPath, 'utf8'));
    interrupted.status = 'VERIFYING';
    await writeFile(runPath, JSON.stringify(interrupted), 'utf8');
    const completed = await workflow.continue(planned.id, false);
    expect(completed.status).toBe('READY_FOR_PR');
  });
});
