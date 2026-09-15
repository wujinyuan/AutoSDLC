#!/usr/bin/env node
import { readFile } from 'fs/promises';
import path from 'path';
import { AutoSdlcWorkflow } from './workflow';
import { TaskInput } from './types';
import { startConsoleServer } from '../web/console-server';

interface ParsedArgs {
  command: string;
  values: Map<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const values = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) values.set(key, true);
    else {
      values.set(key, next);
      index += 1;
    }
  }
  return { command, values };
}

export function strictFlag(args: ParsedArgs, name: string): boolean {
  const value = args.values.get(name);
  if (value === undefined) return false;
  if (value !== true) throw new Error(`--${name} does not accept a value.`);
  return true;
}

function required(args: ParsedArgs, name: string): string {
  const value = args.values.get(name);
  if (typeof value !== 'string') throw new Error(`--${name} is required.`);
  return value;
}

function usage(): string {
  return `AutoSDLC MVP

Usage:
  autosdlc start --project <git-root> --profile <profile.json> --task <task.json>
  autosdlc continue --project <git-root> --profile <profile.json> --run <id> --approve-plan
  autosdlc status --project <git-root> --profile <profile.json> --run <id>
  autosdlc publish --project <git-root> --profile <profile.json> --run <id>
  autosdlc web --project <git-root> --profile <profile.json> [--port 4177]

The start command creates an isolated Git worktree and proposes a plan. It never
implements before an explicit continue --approve-plan. Publish creates a commit,
pushes the run branch, and opens a Draft pull request.`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || strictFlag(args, 'help')) {
    console.log(usage());
    return;
  }
  const project = path.resolve(required(args, 'project'));
  const profile = path.resolve(required(args, 'profile'));
  const stateValue = args.values.get('state-dir');
  const workflow = new AutoSdlcWorkflow({
    projectPath: project,
    profilePath: profile,
    stateDir: typeof stateValue === 'string' ? path.resolve(stateValue) : undefined,
  });

  if (args.command === 'web') {
    const portValue = args.values.get('port');
    const port = typeof portValue === 'string' ? Number(portValue) : 4177;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('--port must be an integer between 1 and 65535.');
    }
    await startConsoleServer({
      workflow,
      metadata: { projectPath: project, profilePath: profile },
      port,
    });
    console.log(`AutoSDLC console: http://127.0.0.1:${port}`);
    return;
  }

  if (args.command === 'start') {
    const taskPath = path.resolve(required(args, 'task'));
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as TaskInput;
    if (!task.title || !task.description || !Array.isArray(task.acceptanceCriteria)) {
      throw new Error('Task requires title, description, and acceptanceCriteria.');
    }
    const run = await workflow.start(task);
    console.log(JSON.stringify(run, null, 2));
    console.log(`\nReview: ${path.join(run.stateDir, 'runs', run.id, 'plan.json')}`);
    console.log(
      `Continue: autosdlc continue --project ${project} --profile ${profile} --run ${run.id} --approve-plan`
    );
    return;
  }

  const runId = required(args, 'run');
  if (args.command === 'continue') {
    const run = await workflow.continue(runId, strictFlag(args, 'approve-plan'));
    console.log(JSON.stringify(run, null, 2));
    process.exitCode = ['VERIFICATION_FAILED', 'REVIEW_FAILED', 'FAILED'].includes(run.status)
      ? 2
      : 0;
    return;
  }
  if (args.command === 'status') {
    console.log(JSON.stringify(await workflow.status(runId), null, 2));
    return;
  }
  if (args.command === 'publish') {
    console.log(JSON.stringify(await workflow.publish(runId), null, 2));
    return;
  }
  throw new Error(`Unknown command: ${args.command}\n\n${usage()}`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
