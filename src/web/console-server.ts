import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import { Server } from 'http';
import { AutoSdlcWorkflow } from '../mvp/workflow';
import { RunEvent, RunRecord, TaskInput } from '../mvp/types';

export interface ConsoleWorkflow {
  start(task: TaskInput): Promise<RunRecord>;
  listRuns(): Promise<RunRecord[]>;
  status(runId: string): Promise<RunRecord>;
  events(runId: string): Promise<RunEvent[]>;
  approvePlan(runId: string, actor: string, note?: string): Promise<RunRecord>;
  rejectPlan(runId: string, actor: string, note: string): Promise<RunRecord>;
  continue(runId: string, approvePlan: boolean): Promise<RunRecord>;
  publish(runId: string): Promise<RunRecord>;
  recordActionFailure(runId: string, action: 'continue' | 'publish', error: unknown): Promise<void>;
}

export interface ConsoleMetadata {
  projectPath: string;
  profilePath: string;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function taskFromBody(body: unknown): TaskInput {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Task body is required.');
  const candidate = body as Partial<TaskInput>;
  if (
    typeof candidate.title !== 'string' ||
    !candidate.title.trim() ||
    typeof candidate.description !== 'string' ||
    !candidate.description.trim() ||
    !Array.isArray(candidate.acceptanceCriteria) ||
    candidate.acceptanceCriteria.length === 0 ||
    candidate.acceptanceCriteria.some((item) => typeof item !== 'string' || !item.trim()) ||
    (candidate.nonGoals !== undefined &&
      (!Array.isArray(candidate.nonGoals) ||
        candidate.nonGoals.some((item) => typeof item !== 'string' || !item.trim())))
  ) {
    throw new HttpError(
      400,
      'title, description, and at least one non-empty acceptance criterion are required.'
    );
  }
  return {
    title: candidate.title.trim(),
    description: candidate.description.trim(),
    acceptanceCriteria: candidate.acceptanceCriteria.map((item) => item.trim()),
    nonGoals: candidate.nonGoals?.map((item) => item.trim()),
  };
}

function runView(record: RunRecord, active = false) {
  return {
    id: record.id,
    status: record.status,
    active,
    task: record.task,
    branch: record.branch,
    baseBranch: record.baseBranch,
    baseSha: record.baseSha,
    plan: record.plan,
    approval: record.approval,
    implementationSummary: record.implementationSummary,
    changedPaths: record.changedPaths,
    setupChecks: record.setupChecks?.map(({ name, exitCode, durationMs }) => ({
      name,
      exitCode,
      durationMs,
    })),
    checks: record.checks?.map(({ name, exitCode, durationMs }) => ({
      name,
      exitCode,
      durationMs,
    })),
    review: record.review,
    reviewedTree: record.reviewedTree,
    commitSha: record.commitSha,
    pullRequestUrl: record.pullRequestUrl,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function loopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export function createConsoleApp(
  workflow: ConsoleWorkflow,
  metadata: ConsoleMetadata,
  assetsPath = path.resolve(__dirname, '../../../public/console')
) {
  const app = express();
  const activeRuns = new Set<string>();

  const startAction = (
    runId: string,
    actionName: 'continue' | 'publish',
    action: () => Promise<RunRecord>
  ): void => {
    if (activeRuns.has(runId)) throw new HttpError(409, 'This run already has an active action.');
    activeRuns.add(runId);
    void action()
      .catch(async (error) => {
        console.error(`AutoSDLC ${actionName} failed for ${runId}:`, error);
        try {
          await workflow.recordActionFailure(runId, actionName, error);
        } catch (persistenceError) {
          console.error(
            `AutoSDLC could not persist the ${actionName} failure for ${runId}:`,
            persistenceError
          );
        }
      })
      .finally(() => activeRuns.delete(runId));
  };

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    next();
  });
  app.use('/api', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' || request.method === 'HEAD') return next();
    if (!loopbackHost(request.headers.host)) {
      return next(new HttpError(403, 'Control requests require a loopback Host.'));
    }
    const origin = request.headers.origin;
    if (!origin) return next();
    try {
      if (new URL(origin).host !== request.headers.host) {
        return next(new HttpError(403, 'Cross-origin control requests are not allowed.'));
      }
    } catch {
      return next(new HttpError(403, 'Invalid request origin.'));
    }
    return next();
  });

  app.get('/api/meta', (_request, response) => {
    response.json(metadata);
  });

  app.get('/api/runs', async (_request, response, next) => {
    try {
      response.json(
        (await workflow.listRuns()).map((record) => runView(record, activeRuns.has(record.id)))
      );
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/runs', async (request, response, next) => {
    try {
      const record = await workflow.start(taskFromBody(request.body));
      response.status(201).json(runView(record));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/runs/:runId', async (request, response, next) => {
    try {
      const [record, events] = await Promise.all([
        workflow.status(request.params.runId),
        workflow.events(request.params.runId),
      ]);
      response.json({
        run: runView(record, activeRuns.has(record.id)),
        events,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/runs/:runId/approval', async (request, response, next) => {
    const runId = request.params.runId;
    let acquired = false;
    try {
      if (activeRuns.has(runId)) {
        throw new HttpError(409, 'This run already has an active action.');
      }
      activeRuns.add(runId);
      acquired = true;
      const { decision, actor, note } = request.body ?? {};
      if (
        !['approved', 'rejected'].includes(decision) ||
        typeof actor !== 'string' ||
        !actor.trim()
      ) {
        throw new HttpError(400, 'decision and a non-empty actor are required.');
      }
      if (decision === 'rejected' && (typeof note !== 'string' || !note.trim())) {
        throw new HttpError(400, 'A non-empty rejection note is required.');
      }
      const record =
        decision === 'approved'
          ? await workflow.approvePlan(runId, actor, typeof note === 'string' ? note : undefined)
          : await workflow.rejectPlan(runId, actor, typeof note === 'string' ? note : '');
      response.json(runView(record));
    } catch (error) {
      next(error);
    } finally {
      if (acquired) activeRuns.delete(runId);
    }
  });

  app.post('/api/runs/:runId/continue', async (request, response, next) => {
    try {
      const record = await workflow.status(request.params.runId);
      const resumable = [
        'PLAN_APPROVED',
        'IMPLEMENTING',
        'VERIFYING',
        'REVIEWING',
        'VERIFICATION_FAILED',
        'REVIEW_FAILED',
        'READY_FOR_PR',
        'FAILED',
      ];
      if (!resumable.includes(record.status)) {
        throw new HttpError(409, `Run cannot continue from status ${record.status}.`);
      }
      startAction(request.params.runId, 'continue', () =>
        workflow.continue(request.params.runId, false)
      );
      response.status(202).json({ accepted: true, runId: request.params.runId });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/runs/:runId/publish', async (request, response, next) => {
    try {
      const record = await workflow.status(request.params.runId);
      if (record.status !== 'READY_FOR_PR') {
        throw new HttpError(
          409,
          `Only READY_FOR_PR runs can be published; current status is ${record.status}.`
        );
      }
      startAction(request.params.runId, 'publish', () => workflow.publish(request.params.runId));
      response.status(202).json({ accepted: true, runId: request.params.runId });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', (_request, _response, next) => next(new HttpError(404, 'API route not found.')));
  app.use(express.static(assetsPath, { index: false, fallthrough: true }));
  app.get('*', (_request, response) => response.sendFile(path.join(assetsPath, 'index.html')));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    response.status(statusCode).json({ error: message });
  });

  return app;
}

export function startConsoleServer(options: {
  workflow: AutoSdlcWorkflow;
  metadata: ConsoleMetadata;
  host?: string;
  port?: number;
}): Promise<Server> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4177;
  const app = createConsoleApp(options.workflow, options.metadata);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}
