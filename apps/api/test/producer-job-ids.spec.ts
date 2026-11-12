import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Job } from 'bullmq';
import { AgentProducer } from '../src/agents/agent.producer.js';
import { WorkflowProducer } from '../src/workflows/workflow.producer.js';

const ID = '7b0d1c5e-3f2a-4c6b-8d9e-0a1b2c3d4e5f';

/**
 * BullMQ's own rule for a custom id, run without Redis: `Job.validateOptions`
 * is what `queue.add` calls before anything is sent, and it reads only the
 * job's options.
 */
function accepts(jobId: string): boolean {
  try {
    (Job.prototype as unknown as { validateOptions(this: unknown, data: unknown): void }).validateOptions.call({ opts: { jobId }, name: 'x' }, { data: '{}' });
    return true;
  } catch (e) {
    if (/Custom Id/.test((e as Error).message)) return false;
    throw e;
  }
}

function producerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? producerFiles(join(dir, e.name)) : e.name.endsWith('.producer.ts') ? [join(dir, e.name)] : []));
}

describe('producer job ids (#997)', () => {
  it('BullMQ refuses a custom id with a colon, which is what stranded stale retries', () => {
    expect(accepts(`${ID}:2`)).toBe(false);
    expect(accepts(`${ID}#2`)).toBe(true);
    expect(accepts(ID)).toBe(true);
  });

  it('a retried agent run and a retried workflow step are enqueued under an id BullMQ accepts', async () => {
    for (const Producer of [AgentProducer, WorkflowProducer]) {
      const added: string[] = [];
      const queue = { add: async (_name: string, _data: unknown, opts: { jobId: string }) => void added.push(opts.jobId) };
      const producer = new Producer(queue as never);
      await producer.enqueue(ID);
      await producer.enqueueRetry(ID, 2);
      expect(added).toEqual([ID, `${ID}#2`]);
      for (const jobId of added) expect([jobId, accepts(jobId)]).toEqual([jobId, true]);
    }
  });

  it('no producer builds a job id with a colon in it', () => {
    const files = producerFiles(join(import.meta.dirname, '../src'));
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      // Every `jobId:` template literal in the file; the separator a new producer picks is checked as it lands.
      for (const [, template] of readFileSync(file, 'utf8').matchAll(/jobId:[^`\n]*`([^`]*)`/g)) {
        expect([file.split('/src/')[1], template, template!.includes(':')]).toEqual([file.split('/src/')[1], template, false]);
      }
    }
  });
});
