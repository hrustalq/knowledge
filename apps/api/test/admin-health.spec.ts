import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { MONITORED_QUEUES, scrubCredentials } from '../src/admin/admin-health.service.js';
import { reportTicksTo, Ticker, type TickReport } from '../src/common/ticker.js';
import { OPS_PROCESSES_KEY, OPS_TICKS_KEY, readBeacons } from '../src/observability/ops-beacon.js';
import type { SharedRedis } from '../src/redis/shared-redis.js';

// The admin console's monitoring view (#1238).

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });

describe('monitored queues', () => {
  it('lists every queue a module registers', () => {
    const text = sources(join(import.meta.dirname, '..', 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');
    const registered = [...text.matchAll(/registerQueue\(\{\s*name:\s*(\w+)\s*\}\)/g)].map(([, ident]) => {
      const value = new RegExp(`export const ${ident} = '([^']+)'`).exec(text)?.[1];
      expect(value, `${ident} has no string constant`).toBeDefined();
      return value!;
    });
    expect(registered.length).toBeGreaterThan(10);
    expect([...MONITORED_QUEUES].sort()).toEqual([...new Set(registered)].sort());
  });
});

describe('Ticker reports', () => {
  afterEach(() => reportTicksTo(undefined));

  it('reports each finished pass under its logger name, a failed one as not ok, a busy one never', async () => {
    const seen: TickReport[] = [];
    reportTicksTo((t) => seen.push(t));
    const ticker = new Ticker(new Logger('SomeSweeper'));
    let release!: () => void;
    const first = ticker.exclusive(() => new Promise<void>((r) => (release = r)));
    await ticker.exclusive(async () => undefined); // busy: skipped, unreported
    release();
    await first;
    await ticker.exclusive(async () => {
      throw new Error('boom');
    });
    expect(seen.map((t) => [t.name, t.ok, t.intervalMs])).toEqual([
      ['SomeSweeper', true, null],
      ['SomeSweeper', false, null],
    ]);
  });
});

describe('readBeacons', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const fakeRedis = (hashes: Record<string, Record<string, string>>) => {
    const deleted: Record<string, string[]> = {};
    const client = {
      hgetall: async (key: string) => hashes[key] ?? {},
      hdel: async (key: string, ...fields: string[]) => void (deleted[key] = fields),
    };
    return { redis: { client } as unknown as SharedRedis, deleted };
  };
  const proc = (kind: string, host: string, agoMs: number) =>
    JSON.stringify({ kind, host, pid: 1, version: '0.60.0', startedAt: '2026-11-18T00:00:00Z', at: now - agoMs });
  const tick = (process: string, name: string, agoMs: number, intervalMs: number | null) =>
    JSON.stringify({ process, name, host: 'h', intervalMs, at: now - agoMs, ok: true, ms: 3 });

  it('marks live and silent instances, prunes the long-silent, and keeps expected kinds with none live', async () => {
    const { redis, deleted } = fakeRedis({
      [OPS_PROCESSES_KEY]: {
        'api:a:1': proc('api', 'a', 5_000),
        'worker:b:1': proc('worker', 'b', 90_000),
        'worker:c:1': proc('worker', 'c', 10 * 60_000),
        'git:d:1': proc('git', 'd', 1_000),
      },
      [OPS_TICKS_KEY]: {
        'api:Fresh': tick('api', 'Fresh', 10_000, 30_000),
        'worker:Late': tick('worker', 'Late', 3 * 30_000 + 61_000, 30_000),
        'worker:Gone': tick('worker', 'Gone', 2 * 86_400_000, 30_000),
        'api:Manual': tick('api', 'Manual', 3_600_000, null),
      },
    });
    const { processes, ticks } = await readBeacons(redis, { api: true, worker: true, learner: true, git: false }, now);

    expect(processes.map((p) => [p.kind, p.expected, p.instances.map((i) => [i.host, i.live])])).toEqual([
      ['api', true, [['a', true]]],
      ['worker', true, [['b', false]]],
      ['learner', true, []],
      ['git', false, [['d', true]]],
    ]);
    expect(deleted[OPS_PROCESSES_KEY]).toEqual(['worker:c:1']);
    expect(ticks.map((t) => [t.name, t.late])).toEqual([
      ['Fresh', false],
      ['Manual', false],
      ['Late', true],
    ]);
    expect(deleted[OPS_TICKS_KEY]).toEqual(['worker:Gone']);
  });
});

describe('scrubCredentials', () => {
  it('strips userinfo from every URL in a message', () => {
    expect(scrubCredentials('connect redis://:s3cret@redis:6379 and http://u:p@os:9200/x failed')).toBe(
      'connect redis://redis:6379 and http://os:9200/x failed',
    );
  });
});
