import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AGENT_SCHEDULE_TICK_MINUTES, isScheduleDue } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { asLocale } from '../i18n/locale.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentProducer } from './agent.producer.js';
import { AGENT_MAX_ATTEMPTS } from './agent.constants.js';
import { RUNNABLE_AGENTS } from './agent.executor.js';
import { scheduleOf } from './agent-schedule.js';

/** One tick; a schedule's own interval or slot is checked inside it. */
const SWEEP_INTERVAL_MS = AGENT_SCHEDULE_TICK_MINUTES * 60_000;
/** Schedules started per sweep. The next sweep continues — the StaleSweeper rule. */
const BATCH = 10;
/** A run still 'running' after this is presumed dead and re-queued. */
const STALE_RUN_MS = 30 * 60_000;
/** A run still 'pending' after this has probably lost its job (#657) and is enqueued again. */
const STALE_PENDING_MS = 10 * 60_000;

/**
 * Starts scheduled agent runs, and recovers ones that died mid-flight
 * (docs/features/20).
 *
 * Copied in shape from `ConnectorScheduleSweeper`, deliberately: this repo has
 * no `@nestjs/schedule`, no `@Cron` and no BullMQ repeatables, and its one
 * user-configurable schedule — `Connector.syncIntervalMinutes` — is a due check
 * inside a fixed tick. Adding a second, different scheduling mechanism for the
 * same shape of problem would be the wrong kind of novelty.
 *
 * Its back-pressure rule carries over too: a run is refused while one is
 * already in flight for that agent, so an agent slower than its interval falls
 * behind rather than piling up.
 *
 * The recovery half runs whether or not schedules are on (#657): every run —
 * manual, trigger, lint, drift, memo — is a row committed before its job, and
 * this is the one relay that re-enqueues a row whose job was lost or whose
 * worker died. Only `startDue` is behind `AGENT_SCHEDULE_ENABLED`.
 */
@Injectable()
export class AgentScheduleSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentScheduleSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private schedulesEnabled = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: AgentProducer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.schedulesEnabled = this.config.get('AGENT_SCHEDULE_ENABLED', { infer: true });
    if (!this.schedulesEnabled) this.logger.log('Agent schedules disabled (AGENT_SCHEDULE_ENABLED=false); run recovery stays on');
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.requeueStuck();
      await this.relayPending();
      if (this.schedulesEnabled) await this.startDue();
    } catch (error) {
      this.logger.warn(`Agent schedule sweep failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** A worker that died mid-run leaves a row claimed forever without this. */
  private async requeueStuck(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_RUN_MS);
    const stuck = await this.prisma.agentRun.findMany({
      where: { status: 'running', updatedAt: { lt: cutoff }, attempt: { lt: AGENT_MAX_ATTEMPTS } },
      select: { id: true, attempt: true },
      take: BATCH,
    });
    for (const run of stuck) {
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'pending', attempt: { increment: 1 } },
      });
      // A retry needs a fresh jobId: the kept failed job blocks reuse.
      await this.producer.enqueueRetry(run.id, run.attempt + 1);
    }
  }

  /**
   * The outbox relay (#657), `OutboxSweeper`'s shape: a `pending` row whose
   * enqueue was lost after its commit is enqueued again under the jobId of its
   * last enqueue, so a row whose job is merely waiting collapses into it. A
   * duplicate that slips through still loses the processor's guarded claim.
   */
  private async relayPending(): Promise<void> {
    const stale = await this.prisma.agentRun.findMany({
      where: { status: 'pending', updatedAt: { lt: new Date(Date.now() - STALE_PENDING_MS) } },
      select: { id: true, attempt: true },
      orderBy: { updatedAt: 'asc' },
      take: BATCH * 2,
    });
    for (const run of stale) {
      this.logger.log(`Re-enqueueing stale pending agent run ${run.id}`);
      // `attempt` is 0 until `requeueStuck` hands the row to a retry.
      if (run.attempt === 0) await this.producer.enqueue(run.id);
      else await this.producer.enqueueRetry(run.id, run.attempt);
    }
  }

  private async startDue(): Promise<void> {
    const candidates = await this.prisma.aiAgent.findMany({
      where: {
        scheduleEnabled: true,
        // An interval needs minutes, a daily or weekly schedule a time (#70).
        // The predicate below has the final word on either.
        OR: [{ scheduleMinutes: { not: null } }, { scheduleTime: { not: null } }],
        // No owner means nobody to run as. Skipping is the whole point: this
        // feature will not invent an identity to keep a schedule alive.
        scheduleOwner: { not: null },
        enabled: true,
      },
      // Longest-waiting first, so a workspace with many not-yet-due schedules
      // cannot keep a due one out of the window.
      orderBy: { lastRunAt: { sort: 'asc', nulls: 'first' } },
      take: BATCH * 3,
    });

    let started = 0;
    for (const agent of candidates) {
      if (started >= BATCH) break;
      // An agent whose `background` surface has no executor behind it would
      // fail every interval, on the interval. The API refuses such a run at the
      // point somebody asks for it; a schedule must be refused for the same
      // reason, rather than turning into a recurring failed job.
      if (!RUNNABLE_AGENTS.has(agent.key)) continue;
      // The same predicate the summary's "next run" reads (#70), so the
      // editor never promises a run the sweeper would not start.
      const { spec, state } = scheduleOf(agent);
      if (!isScheduleDue(spec, state, new Date())) continue;

      // Back-pressure: never a second run while one is in flight.
      const inFlight = await this.prisma.agentRun.count({
        where: { workspaceId: agent.workspaceId, agentKey: agent.key, status: { in: ['pending', 'running'] } },
      });
      if (inFlight > 0) continue;

      try {
        // A manual run freezes the principal's locale; a scheduled one has no
        // principal, so it is frozen from the owner's stored preference. Left
        // unset, the column's `"en"` default made every nightly summary
        // English in a Russian workspace.
        const owner = await this.prisma.user.findUnique({
          where: { id: agent.scheduleOwner! },
          select: { locale: true },
        });
        // The run and the stamp that says it started commit together (#657);
        // the job follows the commit, and `relayPending` covers a lost one.
        await this.prisma.withTransaction(async () => {
          const run = await this.prisma.agentRun.create({
            data: {
              workspaceId: agent.workspaceId,
              agentKey: agent.key,
              agentId: agent.id,
              trigger: 'schedule',
              createdBy: agent.scheduleOwner!,
              locale: asLocale(owner?.locale),
              input: agent.scheduleNote ? { note: agent.scheduleNote } : undefined,
            },
          });
          await this.prisma.aiAgent.update({ where: { id: agent.id }, data: { lastRunAt: new Date() } });
          this.prisma.onCommit(() => this.producer.enqueue(run.id));
        });
        started++;
      } catch (error) {
        // One bad schedule must not stop the sweep for every other workspace.
        this.logger.warn(`Could not start scheduled run for ${agent.key}: ${String(error)}`);
      }
    }
  }
}
