import { randomUUID } from 'crypto';
import { appendFile, link, mkdir, readFile, readdir, rename, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { RunEvent, RunRecord } from './types';

export class RunStore {
  constructor(private readonly root: string) {}

  runDir(runId: string): string {
    if (!/^\d{14}-[a-f0-9]{8}$/.test(runId)) {
      throw new Error(`Invalid run id: ${runId}`);
    }
    return path.join(this.root, 'runs', runId);
  }

  artifactPath(runId: string, name: string): string {
    return path.join(this.runDir(runId), name);
  }

  async initialize(record: RunRecord): Promise<void> {
    await mkdir(this.runDir(record.id), { recursive: true });
    await this.save(record);
    await this.event(record, 'run.created', { baseSha: record.baseSha });
  }

  async save(record: RunRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await mkdir(this.runDir(record.id), { recursive: true });
    const target = this.artifactPath(record.id, 'run.json');
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  }

  async load(runId: string): Promise<RunRecord> {
    const raw = await readFile(this.artifactPath(runId, 'run.json'), 'utf8');
    return JSON.parse(raw) as RunRecord;
  }

  async list(): Promise<RunRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(path.join(this.root, 'runs'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: RunRecord[] = [];
    for (const entry of entries) {
      if (!/^\d{14}-[a-f0-9]{8}$/.test(entry)) continue;
      records.push(await this.load(entry));
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async events(runId: string): Promise<RunEvent[]> {
    try {
      const raw = await readFile(this.artifactPath(runId, 'events.jsonl'), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeArtifact(runId: string, name: string, content: string): Promise<void> {
    await mkdir(this.runDir(runId), { recursive: true });
    await writeFile(this.artifactPath(runId, name), content, 'utf8');
  }

  async createArtifact(runId: string, name: string, content: string): Promise<void> {
    await mkdir(this.runDir(runId), { recursive: true });
    const target = this.artifactPath(runId, name);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
      await link(temporary, target);
    } finally {
      try {
        await unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  async event(record: RunRecord, type: string, details?: Record<string, unknown>): Promise<void> {
    const event: RunEvent = {
      timestamp: new Date().toISOString(),
      runId: record.id,
      type,
      status: record.status,
      details,
    };
    await mkdir(this.runDir(record.id), { recursive: true });
    await appendFile(
      this.artifactPath(record.id, 'events.jsonl'),
      `${JSON.stringify(event)}\n`,
      'utf8'
    );
  }
}
