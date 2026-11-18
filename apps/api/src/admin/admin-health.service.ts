import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { AdminDependency, AdminDependencyName, AdminHealthResponse, AdminQueue } from '@knowledge/contracts';
import { AGENT_QUEUE } from '../agents/agent.constants.js';
import { API_TEST_RUN_QUEUE } from '../api-specs/api-test-run.producer.js';
import type { Env } from '../config/env.js';
import { PRODUCT_VERSION } from '../config/version.js';
import { CONNECTOR_QUEUE } from '../connectors/connector.constants.js';
import { EMBEDS_QUEUE } from '../embeds/embeds.constants.js';
import { EXPORT_QUEUE } from '../export/export.constants.js';
import { GraphService } from '../graph/graph.service.js';
import { IMPORT_QUEUE } from '../import/import.constants.js';
import { INGESTION_QUEUE } from '../ingestion/ingestion.constants.js';
import { redisConnectionFromUrl } from '../ingestion/redis.util.js';
import { MAIL_QUEUE } from '../mail/mail.constants.js';
import { MEMO_QUEUE } from '../memos/memos.constants.js';
import { MEMORY_QUEUE } from '../memory/memory.constants.js';
import { readBeacons } from '../observability/ops-beacon.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SITE_BUILD_QUEUE } from '../publishing/site-build.constants.js';
import { SharedRedis } from '../redis/shared-redis.js';
import { StorageService } from '../storage/storage.service.js';
import { WORKFLOW_QUEUE } from '../workflows/workflow.constants.js';

/** Every `BullModule.registerQueue` name. `admin-health.spec.ts` fails when one is missing. */
export const MONITORED_QUEUES = [
  INGESTION_QUEUE,
  CONNECTOR_QUEUE,
  AGENT_QUEUE,
  WORKFLOW_QUEUE,
  MEMORY_QUEUE,
  MEMO_QUEUE,
  MAIL_QUEUE,
  EMBEDS_QUEUE,
  SITE_BUILD_QUEUE,
  EXPORT_QUEUE,
  IMPORT_QUEUE,
  API_TEST_RUN_QUEUE,
] as const;

const PROBE_TIMEOUT_MS = 2_000;

/** Runs `fn`, rejecting after `ms`; the signal aborts whatever `fn` started. */
async function within<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(abort.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error message may quote a URL with its credentials (a Redis or OpenSearch DSN). */
export const scrubCredentials = (message: string) => message.replace(/\/\/[^/\s@]*@/g, '//');

async function probe(name: AdminDependencyName, run: (signal: AbortSignal) => Promise<unknown>): Promise<AdminDependency> {
  const started = Date.now();
  try {
    await within(PROBE_TIMEOUT_MS, run);
    return { name, status: 'up', latencyMs: Date.now() - started, error: null };
  } catch (error) {
    // fetch() says only "fetch failed"; the reason (ECONNREFUSED, ENOTFOUND) is on its cause.
    const cause = (error as { cause?: { code?: string } } | null)?.cause?.code;
    const message = error instanceof Error ? (error.message || error.name) + (cause ? ` (${cause})` : '') : String(error);
    return { name, status: 'down', latencyMs: Date.now() - started, error: scrubCredentials(message) };
  }
}

async function httpOk(url: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

const off = (name: AdminDependencyName): AdminDependency => ({ name, status: 'off', latencyMs: null, error: null });

/**
 * The admin console's monitoring view (#1238), read fresh on every call: no
 * cache, because the page polls it and a cached "up" is the one answer it must
 * never give. Each part fails on its own, so a down Redis still shows the
 * stores, and a hung ArcadeDB costs at most the probe timeout.
 */
@Injectable()
export class AdminHealthService implements OnModuleDestroy {
  /** Queues this process does not register itself, opened on first read. */
  private readonly own = new Map<string, Queue>();

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly prisma: PrismaService,
    private readonly redis: SharedRedis,
    private readonly storage: StorageService,
    private readonly graph: GraphService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async read(): Promise<AdminHealthResponse> {
    const [dependencies, queues, beacons] = await Promise.all([
      this.dependencies(),
      Promise.all(MONITORED_QUEUES.map((name) => this.queue(name))),
      within(PROBE_TIMEOUT_MS, () =>
        readBeacons(this.redis, {
          api: true,
          worker: true,
          learner: this.config.get('LEARNER_ENABLED', { infer: true }),
          git: this.config.get('GIT_REMOTE_ENABLED', { infer: true }),
        }),
      ).catch(() => null),
    ]);
    return {
      checkedAt: new Date().toISOString(),
      version: PRODUCT_VERSION,
      dependencies,
      queues,
      processes: beacons?.processes ?? null,
      ticks: beacons?.ticks ?? null,
    };
  }

  private dependencies(): Promise<AdminDependency[]> {
    const opensearch = this.config.get('FULLTEXT_PROVIDER', { infer: true }) === 'opensearch';
    const searxng = this.config.get('WEB_SEARCH_URL', { infer: true });
    return Promise.all([
      probe('postgres', () => this.prisma.$queryRaw`SELECT 1`),
      probe('redis', () => this.redis.client.ping()),
      probe('minio', (signal) => this.storage.ping(signal)),
      probe('arcadedb', () => this.graph.ping()),
      opensearch
        ? probe('opensearch', (signal) =>
            httpOk(`${this.config.get('OPENSEARCH_URL', { infer: true }).replace(/\/$/, '')}/_cluster/health`, signal),
          )
        : off('opensearch'),
      searxng ? probe('searxng', (signal) => httpOk(new URL('/healthz', searxng.replace(/\/$/, '')).href, signal)) : off('searxng'),
    ]);
  }

  onModuleDestroy(): Promise<unknown> {
    return Promise.all([...this.own.values()].map((q) => q.close().catch(() => undefined)));
  }

  /**
   * The Queue the API already holds as a producer, so a read opens no
   * connection; one it does not register gets its own, kept for the process.
   */
  private queueFor(name: string): Queue {
    try {
      return this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
    } catch {
      let queue = this.own.get(name);
      if (!queue) {
        queue = new Queue(name, { connection: redisConnectionFromUrl(this.config.get('REDIS_URL', { infer: true })) });
        // BullMQ re-emits connection errors on the queue; an `error` with no listener crashes the process.
        queue.on('error', () => undefined);
        this.own.set(name, queue);
      }
      return queue;
    }
  }

  private async queue(name: string): Promise<AdminQueue> {
    try {
      const c = await within(PROBE_TIMEOUT_MS, () =>
        this.queueFor(name).getJobCounts('waiting', 'paused', 'prioritized', 'active', 'delayed', 'failed'),
      );
      // A paused queue's jobs and a prioritized job sit in their own lists, but to an operator they are all waiting.
      const waiting = (c.waiting ?? 0) + (c.paused ?? 0) + (c.prioritized ?? 0);
      return { name, counts: { waiting, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0 } };
    } catch {
      return { name, counts: null };
    }
  }
}
