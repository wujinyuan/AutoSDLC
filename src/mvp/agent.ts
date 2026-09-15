import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { AgentRequest, AgentResult, ProjectProfile } from './types';
import { requireSuccess } from './process';

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>;
}

export class CodexCliAgent implements AgentRunner {
  constructor(
    private readonly profile: ProjectProfile,
    private readonly artifactDir: string
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    await mkdir(this.artifactDir, { recursive: true });
    const executable = this.profile.agent?.executable ?? 'codex';
    const outputFile = path.join(this.artifactDir, `${request.phase}-agent-output.txt`);
    const args = [
      ...(this.profile.agent?.args ?? []),
      'exec',
      '--ephemeral',
      '--color',
      'never',
      '--sandbox',
      request.phase === 'implement' ? 'workspace-write' : 'read-only',
      '-C',
      request.workspace,
      '-o',
      outputFile,
    ];
    if (this.profile.agent?.model) args.push('--model', this.profile.agent.model);
    if (request.outputSchema) {
      const schemaFile = path.join(this.artifactDir, `${request.phase}-schema.json`);
      await writeFile(schemaFile, JSON.stringify(request.outputSchema, null, 2), 'utf8');
      args.push('--output-schema', schemaFile);
    }
    args.push('-');

    const result = await requireSuccess(executable, args, {
      cwd: request.workspace,
      stdin: request.prompt,
      timeoutMs: 30 * 60 * 1000,
    });
    return {
      output: await readFile(outputFile, 'utf8'),
      command: result.command,
    };
  }
}
