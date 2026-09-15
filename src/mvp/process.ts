import { spawn } from 'child_process';

export interface ProcessResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ProcessOptions {
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may already have exited; fall back to the child handle.
        }
      }
      child.kill(signal);
    };
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate('SIGTERM');
          forceKill = setTimeout(() => terminate('SIGKILL'), options.killGraceMs ?? 2_000);
        }, options.timeoutMs)
      : undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve({
        command: [command, ...args],
        exitCode: timedOut ? 124 : code ?? 1,
        stdout,
        stderr: timedOut ? `${stderr}\nProcess timed out.`.trim() : stderr,
        durationMs: Date.now() - startedAt,
      });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

export async function requireSuccess(
  command: string,
  args: string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${result.command.join(' ')} failed (${result.exitCode}): ${detail}`);
  }
  return result;
}
