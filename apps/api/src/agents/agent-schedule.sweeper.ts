import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentProducer } from './agent.producer.js';
import { AGENT_MAX_ATTEMPTS } from './agent.constants.js';
import { RUNNABLE_AGENTS } from './agent.executor.js';

/** One tick; a schedule's own interval is checked inside it. */
const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Schedules started per sweep. The next sweep continues — the StaleSweeper rule. */
const BATCH = 10;
/** A run still 'running' after this is presumed dead and re-queued. */
const STALE_RUN_MS = 30 * 60_000;

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
 */
@Injectable()
export class AgentScheduleSweeper implements OnModuleInit {
  private readonly logger = new Logger(AgentScheduleSweeper.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: AgentProducer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('AGENT_SCHEDULE_ENABLED', { infer: true })) {
      this.logger.log('Agent schedules disabled (AGENT_SCHEDULE_ENABLED=false)');
      return;
    }
    setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS).unref();
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.requeueStuck();
      await this.startDue();
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

  private async startDue(): Promise<void> {
    const candidates = await this.prisma.aiAgent.findMany({
      where: {
        scheduleEnabled: true,
        scheduleMinutes: { not: null },
        // No owner means nobody to run as. Skipping is the whole point: this
        // feature will not invent an identity to keep a schedule alive.
        scheduleOwner: { not: null },
        enabled: true,
      },
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
      const due =
        !agent.lastRunAt || agent.lastRunAt.getTime() + (agent.scheduleMinutes ?? 0) * 60_000 <= Date.now();
      if (!due) continue;

      // Back-pressure: never a second run while one is in flight.
      const inFlight = await this.prisma.agentRun.count({
        where: { workspaceId: agent.workspaceId, agentKey: agent.key, status: { in: ['pending', 'running'] } },
      });
      if (inFlight > 0) continue;

      try {
        const run = await this.prisma.agentRun.create({
          data: {
            workspaceId: agent.workspaceId,
            agentKey: agent.key,
            agentId: agent.id,
            trigger: 'schedule',
            createdBy: agent.scheduleOwner!,
            input: agent.scheduleNote ? { note: agent.scheduleNote } : undefined,
          },
        });
        await this.prisma.aiAgent.update({ where: { id: agent.id }, data: { lastRunAt: new Date() } });
        await this.producer.enqueue(run.id);
        started++;
      } catch (error) {
        // One bad schedule must not stop the sweep for every other workspace.
        this.logger.warn(`Could not start scheduled run for ${agent.key}: ${String(error)}`);
      }
    }
  }
}
