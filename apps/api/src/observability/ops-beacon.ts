import { hostname } from 'node:os';
import { Inject, Injectable, Logger, Module, type DynamicModule, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AdminProcess, AdminTick, OpsProcessKind } from '@knowledge/contracts';
import { OPS_PROCESS_KINDS } from '@knowledge/contracts';
import { reportTicksTo, Ticker, type TickReport } from '../common/ticker.js';
import { PRODUCT_VERSION } from '../config/version.js';
import { RedisModule } from '../redis/redis.module.js';
import { SharedRedis } from '../redis/shared-redis.js';

/**
 * What the admin console's monitoring view (#1238) knows about processes it is
 * not: each long-running entrypoint writes a heartbeat and every sweeper pass
 * into two Redis hashes, and the API reads them back. Hashes rather than a key
 * per entry, so a read is two HGETALLs instead of a SCAN of the whole keyspace;
 * the price is that a field has no TTL, so the reader prunes what went silent.
 */
export const OPS_PROCESSES_KEY = 'ops:processes';
export const OPS_TICKS_KEY = 'ops:ticks';

const HEARTBEAT_MS = 15_000;
/** An instance heard from within this long is live. */
const LIVE_MS = 60_000;
/** A silent instance is dropped after this; its kind then reads "none live". */
const DROP_PROCESS_MS = 5 * 60_000;
/** A sweeper that stopped existing (renamed, removed, its process gone) fades out after a day. */
const DROP_TICK_MS = 86_400_000;

const OPS_PROCESS_KIND = Symbol('OPS_PROCESS_KIND');

interface StoredProcess {
  kind: OpsProcessKind;
  host: string;
  pid: number;
  version: string;
  startedAt: string;
  at: number;
}

type StoredTick = TickReport & { process: OpsProcessKind; host: string };

@Injectable()
class OpsBeacon implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpsBeacon.name);
  private readonly ticker = new Ticker(this.logger);
  private readonly host = hostname();
  private readonly field: string;
  private readonly startedAt = new Date().toISOString();

  constructor(
    @Inject(OPS_PROCESS_KIND) private readonly kind: OpsProcessKind,
    private readonly redis: SharedRedis,
  ) {
    this.field = `${kind}:${this.host}:${process.pid}`;
  }

  onModuleInit(): void {
    reportTicksTo((tick) => {
      const stored: StoredTick = { ...tick, process: this.kind, host: this.host };
      this.redis.client.hset(OPS_TICKS_KEY, `${this.kind}:${tick.name}`, JSON.stringify(stored)).catch(() => undefined);
    });
    this.ticker.every(HEARTBEAT_MS, () => this.beat());
    void this.beat();
  }

  onModuleDestroy(): void {
    this.ticker.stop();
    reportTicksTo(undefined);
    this.redis.client.hdel(OPS_PROCESSES_KEY, this.field).catch(() => undefined);
  }

  /** Fails silently: a down Redis is what the console reports, not something to log every 15 s. */
  beat(): Promise<void> {
    return this.ticker.exclusive(async () => {
      const stored: StoredProcess = {
        kind: this.kind,
        host: this.host,
        pid: process.pid,
        version: PRODUCT_VERSION,
        startedAt: this.startedAt,
        at: Date.now(),
      };
      await this.redis.client.hset(OPS_PROCESSES_KEY, this.field, JSON.stringify(stored)).catch(() => undefined);
    });
  }
}

/**
 * One per long-running entrypoint (AppModule, WorkerModule, LearnerModule,
 * GitModule), never in BootstrapModule: that also boots the OpenAPI generator
 * and the MCP stdio process, which are not processes anyone monitors.
 */
@Module({})
export class OpsBeaconModule {
  static forProcess(kind: OpsProcessKind): DynamicModule {
    return {
      module: OpsBeaconModule,
      imports: [RedisModule],
      providers: [{ provide: OPS_PROCESS_KIND, useValue: kind }, OpsBeacon],
    };
  }
}

const parse = <T>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/**
 * The heartbeats and ticks, as the console shows them. Prunes silent fields on
 * the way (the one write a read makes). Throws when Redis does; the caller
 * turns that into "could not be read".
 */
export async function readBeacons(
  redis: SharedRedis,
  expected: Record<OpsProcessKind, boolean>,
  now = Date.now(),
): Promise<{ processes: AdminProcess[]; ticks: AdminTick[] }> {
  const [rawProcesses, rawTicks] = await Promise.all([
    redis.client.hgetall(OPS_PROCESSES_KEY),
    redis.client.hgetall(OPS_TICKS_KEY),
  ]);

  const stale = { processes: [] as string[], ticks: [] as string[] };
  const instances: StoredProcess[] = [];
  for (const [field, raw] of Object.entries(rawProcesses)) {
    const p = parse<StoredProcess>(raw);
    if (!p || now - p.at > DROP_PROCESS_MS) stale.processes.push(field);
    else instances.push(p);
  }
  const ticks: AdminTick[] = [];
  for (const [field, raw] of Object.entries(rawTicks)) {
    const t = parse<StoredTick>(raw);
    if (!t || now - t.at > DROP_TICK_MS) {
      stale.ticks.push(field);
      continue;
    }
    ticks.push({
      process: t.process,
      name: t.name,
      host: t.host,
      intervalMs: t.intervalMs,
      lastAt: new Date(t.at).toISOString(),
      ok: t.ok,
      ms: t.ms,
      late: t.intervalMs !== null && now - t.at > 3 * t.intervalMs + 60_000,
    });
  }
  if (stale.processes.length) await redis.client.hdel(OPS_PROCESSES_KEY, ...stale.processes);
  if (stale.ticks.length) await redis.client.hdel(OPS_TICKS_KEY, ...stale.ticks);

  const processes = OPS_PROCESS_KINDS.map((kind) => ({
    kind,
    expected: expected[kind],
    instances: instances
      .filter((p) => p.kind === kind)
      .sort((a, b) => a.host.localeCompare(b.host) || a.pid - b.pid)
      .map((p) => ({
        host: p.host,
        pid: p.pid,
        version: p.version,
        startedAt: p.startedAt,
        lastSeenAt: new Date(p.at).toISOString(),
        live: now - p.at <= LIVE_MS,
      })),
  })).filter((p) => p.expected || p.instances.length);

  ticks.sort((a, b) => a.process.localeCompare(b.process) || a.name.localeCompare(b.name));
  return { processes, ticks };
}
