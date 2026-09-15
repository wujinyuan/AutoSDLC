import request from 'supertest';
import path from 'path';
import os from 'os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createConsoleApp, ConsoleWorkflow } from '../../src/web/console-server';
import { AgentRequest, RunEvent, RunRecord, TaskInput } from '../../src/mvp/types';
import { AutoSdlcWorkflow } from '../../src/mvp/workflow';
import { AgentRunner } from '../../src/mvp/agent';
import { requireSuccess } from '../../src/mvp/process';

function record(status: RunRecord['status'] = 'AWAITING_PLAN_APPROVAL'): RunRecord {
  return {
    version: 1,
    id: '20260915120000-1234abcd',
    projectPath: '/project',
    profilePath: '/project/profile.json',
    profileHash: 'profile-hash',
    stateDir: '/state',
    worktreePath: '/secret/worktree',
    branch: 'autosdlc/example',
    baseBranch: 'main',
    baseSha: '0123456789abcdef',
    status,
    task: {
      title: 'Add a health field',
      description: 'Expose a stable version.',
      acceptanceCriteria: ['The field is returned'],
    },
    plan: JSON.stringify({
      summary: 'Add the field.',
      steps: ['Edit handler'],
      expectedFiles: ['src/handler.ts'],
      risks: [],
      verification: ['unit tests'],
    }),
    checks: [
      {
        name: 'unit',
        command: ['npm', 'test'],
        exitCode: 0,
        stdout: 'sensitive output',
        stderr: '',
        durationMs: 10,
      },
    ],
    createdAt: '2026-09-15T12:00:00.000Z',
    updatedAt: '2026-09-15T12:00:00.000Z',
  };
}

function fakeWorkflow() {
  const calls: string[] = [];
  let current = record();
  const workflow: ConsoleWorkflow = {
    async start(task: TaskInput) {
      current = { ...record(), task };
      calls.push('start');
      return current;
    },
    async listRuns() {
      return [current];
    },
    async status() {
      return current;
    },
    async events() {
      return [] as RunEvent[];
    },
    async approvePlan(_runId, actor, note) {
      calls.push(`approve:${actor}:${note ?? ''}`);
      current = {
        ...current,
        status: 'PLAN_APPROVED',
        approval: {
          decision: 'approved',
          actor,
          note,
          decidedAt: new Date().toISOString(),
          planHash: 'plan-hash',
          profileHash: current.profileHash,
          baseSha: current.baseSha,
        },
      };
      return current;
    },
    async rejectPlan(_runId, actor, note) {
      calls.push(`reject:${actor}:${note}`);
      current = { ...current, status: 'PLAN_REJECTED' };
      return current;
    },
    async continue() {
      calls.push('continue');
      return current;
    },
    async publish() {
      calls.push('publish');
      return current;
    },
    async recordActionFailure(_runId, action, error) {
      const message = error instanceof Error ? error.message : String(error);
      calls.push(`failure:${action}:${message}`);
      current = { ...current, status: 'FAILED', error: message };
    },
  };
  return { workflow, calls };
}

describe('AutoSDLC web console API', () => {
  const assets = path.resolve(__dirname, '../../public/console');

  test('serves the working console and project metadata', async () => {
    const { workflow } = fakeWorkflow();
    const app = createConsoleApp(
      workflow,
      { projectPath: '/project', profilePath: '/profile' },
      assets
    );
    await request(app).get('/').expect(200).expect('Content-Type', /html/);
    await request(app)
      .get('/api/meta')
      .expect(200, { projectPath: '/project', profilePath: '/profile' });
  });

  test('returns a redacted run view rather than command output or worktree paths', async () => {
    const { workflow } = fakeWorkflow();
    const app = createConsoleApp(
      workflow,
      { projectPath: '/project', profilePath: '/profile' },
      assets
    );
    const response = await request(app).get('/api/runs').expect(200);
    expect(response.body[0].worktreePath).toBeUndefined();
    expect(response.body[0].checks[0]).toEqual({
      name: 'unit',
      exitCode: 0,
      durationMs: 10,
    });
    expect(JSON.stringify(response.body)).not.toContain('sensitive output');
  });

  test('validates task creation and records explicit approval decisions', async () => {
    const { workflow, calls } = fakeWorkflow();
    const app = createConsoleApp(
      workflow,
      { projectPath: '/project', profilePath: '/profile' },
      assets
    );
    await request(app).post('/api/runs').send({ title: 'Missing fields' }).expect(400);
    await request(app)
      .post('/api/runs/20260915120000-1234abcd/approval')
      .send({ decision: 'approved', actor: '   ' })
      .expect(400);
    await request(app)
      .post('/api/runs/20260915120000-1234abcd/approval')
      .send({ decision: 'rejected', actor: 'Alice', note: '   ' })
      .expect(400);
    await request(app)
      .post('/api/runs/20260915120000-1234abcd/approval')
      .send({ decision: 'approved', actor: 'Alice', note: 'Reviewed.' })
      .expect(200);
    expect(calls).toContain('approve:Alice:Reviewed.');
  });

  test('rejects cross-origin control requests', async () => {
    const { workflow } = fakeWorkflow();
    const app = createConsoleApp(
      workflow,
      { projectPath: '/project', profilePath: '/profile' },
      assets
    );
    await request(app)
      .post('/api/runs/20260915120000-1234abcd/approval')
      .set('Origin', 'https://attacker.example')
      .send({ decision: 'approved', actor: 'Alice' })
      .expect(403);
  });

  test('rejects DNS-rebinding hosts even when Origin and Host match', async () => {
    const { workflow } = fakeWorkflow();
    const app = createConsoleApp(
      workflow,
      { projectPath: '/project', profilePath: '/profile' },
      assets
    );
    await request(app)
      .post('/api/runs/20260915120000-1234abcd/approval')
      .set('Host', 'attacker.example')
      .set('Origin', 'http://attacker.example')
      .send({ decision: 'approved', actor: 'Alice' })
      .expect(403);
  });

  test('starts long-running workflow actions asynchronously and rejects duplicates', async () => {
    const { workflow, calls } = fakeWorkflow();
    await workflow.approvePlan('20260915120000-1234abcd', 'Alice');
    let release: (() => void) | undefined;
    workflow.continue = async () => {
      calls.push('continue');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return record('READY_FOR_PR');
    };
    const app = createConsoleApp(
      workflow,
      { projectPath: '/project', profilePath: '/profile' },
      assets
    );
    await request(app).post('/api/runs/20260915120000-1234abcd/continue').send({}).expect(202);
    await request(app)
      .post('/api/runs/20260915120000-1234abcd/approval')
      .send({ decision: 'approved', actor: 'Alice' })
      .expect(409);
    await request(app).post('/api/runs/20260915120000-1234abcd/continue').send({}).expect(409);
    expect(calls).toContain('continue');
    release?.();
  });

  test('persists failures from accepted background actions', async () => {
    const { workflow, calls } = fakeWorkflow();
    await workflow.approvePlan('20260915120000-1234abcd', 'Alice');
    workflow.continue = async () => {
      throw new Error('worktree disappeared');
    };
    const app = createConsoleApp(
      workflow,
      { projectPath: '/project', profilePath: '/profile' },
      assets
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await request(app).post('/api/runs/20260915120000-1234abcd/continue').send({}).expect(202);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (calls.includes('failure:continue:worktree disappeared')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(calls).toContain('failure:continue:worktree disappeared');
      expect((await workflow.status('20260915120000-1234abcd')).error).toBe('worktree disappeared');
    } finally {
      consoleError.mockRestore();
    }
  });

  test('runs planning, human approval, implementation, and evidence through the HTTP control plane', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'autosdlc-web-e2e-'));
    const projectPath = path.join(temporaryRoot, 'project');
    const profilePath = path.join(temporaryRoot, 'profile.json');
    const stateDir = path.join(temporaryRoot, 'state');
    await mkdir(projectPath);
    await requireSuccess('git', ['init', '-b', 'main'], { cwd: projectPath });
    await requireSuccess('git', ['config', 'user.name', 'Web Console Test'], {
      cwd: projectPath,
    });
    await requireSuccess('git', ['config', 'user.email', 'web-console@example.test'], {
      cwd: projectPath,
    });
    await writeFile(path.join(projectPath, 'README.md'), '# Fixture\n', 'utf8');
    await requireSuccess('git', ['add', 'README.md'], { cwd: projectPath });
    await requireSuccess('git', ['commit', '-m', 'fixture'], {
      cwd: projectPath,
    });
    await writeFile(
      profilePath,
      JSON.stringify({
        version: 1,
        name: 'web-e2e',
        baseBranch: 'main',
        allowedPaths: ['src/**'],
        checks: [
          {
            name: 'verify-result',
            command: 'node',
            args: [
              '-e',
              "if(require('fs').readFileSync('src/result.txt','utf8')!=='approved\\n')process.exit(1)",
            ],
          },
        ],
      }),
      'utf8'
    );
    const agent: AgentRunner = {
      async run(agentRequest: AgentRequest) {
        if (agentRequest.phase === 'plan') {
          return {
            output: JSON.stringify({
              summary: 'Write the approved result.',
              steps: ['Create src/result.txt'],
              expectedFiles: ['src/result.txt'],
              risks: [],
              verification: ['verify-result'],
            }),
            command: ['fake', 'plan'],
          };
        }
        if (agentRequest.phase === 'implement') {
          await mkdir(path.join(agentRequest.workspace, 'src'));
          await writeFile(
            path.join(agentRequest.workspace, 'src', 'result.txt'),
            'approved\n',
            'utf8'
          );
          return {
            output: 'Implemented approved plan.',
            command: ['fake', 'implement'],
          };
        }
        return {
          output: JSON.stringify({
            verdict: 'pass',
            summary: 'Evidence is complete.',
            findings: [],
          }),
          command: ['fake', 'review'],
        };
      },
    };
    const workflow = new AutoSdlcWorkflow({
      projectPath,
      profilePath,
      stateDir,
      agentFactory: () => agent,
    });
    const app = createConsoleApp(workflow, { projectPath, profilePath }, assets);

    try {
      const created = await request(app)
        .post('/api/runs')
        .send({
          title: 'Approve a real HTTP workflow',
          description: 'Exercise the console control plane.',
          acceptanceCriteria: ['The result is approved'],
        })
        .expect(201);
      const runId = created.body.id;
      expect(created.body.status).toBe('AWAITING_PLAN_APPROVAL');

      const approved = await request(app)
        .post(`/api/runs/${runId}/approval`)
        .send({
          decision: 'approved',
          actor: 'Human Reviewer',
          note: 'Plan reviewed.',
        })
        .expect(200);
      expect(approved.body.status).toBe('PLAN_APPROVED');
      expect(approved.body.approval.actor).toBe('Human Reviewer');

      await request(app).post(`/api/runs/${runId}/continue`).send({}).expect(202);
      let finalStatus = '';
      for (let attempt = 0; attempt < 100; attempt += 1) {
        finalStatus = (await workflow.status(runId)).status;
        if (finalStatus === 'READY_FOR_PR') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(finalStatus).toBe('READY_FOR_PR');

      const detail = await request(app).get(`/api/runs/${runId}`).expect(200);
      expect(detail.body.run.checks).toEqual([
        { name: 'verify-result', exitCode: 0, durationMs: expect.any(Number) },
      ]);
      expect(detail.body.run.review.verdict).toBe('pass');
      expect(detail.body.events.map((event: RunEvent) => event.type)).toEqual(
        expect.arrayContaining(['plan.approved', 'verification.completed', 'review.completed'])
      );
      expect(
        JSON.parse(await readFile(path.join(stateDir, 'runs', runId, 'approval.json'), 'utf8'))
          .actor
      ).toBe('Human Reviewer');
    } finally {
      const worktrees = await requireSuccess('git', ['worktree', 'list', '--porcelain'], {
        cwd: projectPath,
      });
      for (const line of worktrees.stdout
        .split('\n')
        .filter((item) => item.startsWith('worktree '))
        .slice(1)) {
        await requireSuccess(
          'git',
          ['worktree', 'remove', '--force', line.slice('worktree '.length)],
          {
            cwd: projectPath,
          }
        );
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
