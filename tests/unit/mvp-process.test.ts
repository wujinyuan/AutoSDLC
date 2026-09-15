import { runProcess } from '../../src/mvp/process';

describe('MVP process runner', () => {
  test('force-kills a process group that ignores SIGTERM', async () => {
    const startedAt = Date.now();
    const result = await runProcess(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { cwd: process.cwd(), timeoutMs: 50, killGraceMs: 50 }
    );
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('Process timed out.');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
