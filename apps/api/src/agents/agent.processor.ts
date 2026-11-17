import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { AgentRun } from '@prisma/client';
import type { Locale } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../auth/access.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { t, withLocale } from '../i18n/t.js';
import { asLocale } from '../i18n/locale.js';
import { runFrameAddress } from '../ai/run-privacy.js';
import { withSubjectLock } from '../common/subject-lock.js';
import { AGENT_QUEUE, MAX_RUN_WARNINGS, agentSubjectLockKey } from './agent.constants.js';
import { AgentProducer } from './agent.producer.js';
import { AgentExecutor } from './agent.executor.js';
import type { AgentReporter } from './agent-services.js';
import { AgentRegistryService } from './agent-registry.service.js';

/**
 * Runs one background agent run per job (docs/features/20).
 *
 * Identity is the part worth reading. A run stores the user it belongs to and
 * rehydrates a real `Principal` from `users` here, then asks the *same*
 * `AccessService.requireRole` an HTTP request would. If that person has since
 * been disabled or demoted, the run fails — it does not fall back to ambient
 * authority, and there is no service principal for it to become. That is the
 * rule feature 17 established restated for unattended work: an admin turned the
 * schedule on and a person owns the run.
 */
@Processor(AGENT_QUEUE)
export class AgentProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentRegistryService,
    private readonly executor: AgentExecutor,
    private readonly access: AccessService,
    private readonly usage: AiUsageService,
    private readonly events: EventsPublisher,
    private readonly producer: AgentProducer,
  ) {
    super();
  }

  async process(job: Job<{ runId: string }>): Promise<void> {
    const runId = job.data.runId;
    const row = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!row) return;

    if (!(await this.claim(row))) return;
    try {
      await this.execute(row);
    } finally {
      // Whatever became of this run, its subject is free now: start whoever
      // queued behind it rather than leaving them to the stale relay (#1248).
      if (row.subjectKey) await this.wakeWaiters(row).catch((e) => this.logger.warn(`Could not wake runs behind ${runId}: ${String(e)}`));
    }
  }

  /**
   * Guarded claim: two workers racing a re-delivered job never ask the model
   * the same question twice (the WorkflowRunnerService.claim pattern).
   *
   * One run per subject at a time (#1248): a run about a page (`doc:<id>`), a
   * merge request or a connector does not start while another run — of any
   * agent — is `running` on the same subject. It stays `pending`, is not
   * refused, and `wakeWaiters` starts it when that one settles. The count and
   * the claim share one lock, or two workers would both count zero. A run with
   * no subject (curator, atlas, digest, a schedule) is never held here: it
   * keeps the per-agent rule it was started under.
   *
   * The progress fields are reset here rather than left alone: a run reaching
   * this line for the second time is a retry, and inheriting the dead
   * execution's stage would have the row claim to be somewhere it is not.
   */
  private async claim(row: AgentRun): Promise<boolean> {
    const take = async () => {
      const claimed = await this.prisma.agentRun.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { status: 'running', startedAt: new Date(), stage: null, progress: 0, warnings: [] },
      });
      return claimed.count === 1;
    };
    const subjectKey = row.subjectKey;
    if (!subjectKey) return take();
    return withSubjectLock(this.prisma, agentSubjectLockKey(row.workspaceId, subjectKey), async () => {
      const busy = await this.prisma.agentRun.count({
        where: { workspaceId: row.workspaceId, subjectKey, status: 'running', id: { not: row.id } },
      });
      return busy === 0 && take();
    });
  }

  /** Re-enqueue every run still waiting on this one's subject, oldest first; the claim lets one through. */
  private async wakeWaiters(row: AgentRun): Promise<void> {
    const waiting = await this.prisma.agentRun.findMany({
      where: { workspaceId: row.workspaceId, subjectKey: row.subjectKey, status: 'pending' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const run of waiting) await this.producer.enqueueWake(run.id);
  }

  private async execute(row: AgentRun): Promise<void> {
    const runId = row.id;

    // The heartbeat (docs/features/29).
    //
    // This row used to be written exactly twice — the claim above and the
    // terminal result below — so `updatedAt` froze at claim time for the whole
    // run, while `AgentScheduleSweeper.requeueStuck` presumes anything still
    // `running` past STALE_RUN_MS is dead. A run that merely took longer than
    // that was re-queued and its model calls paid for a second time. Writing as
    // the run proceeds is what makes `updatedAt` mean "still alive", and the
    // same writes are what the poll endpoint had nothing to show.
    //
    // Every write is guarded on the run still being ours: once the sweeper has
    // handed the row to a retry, this execution must stop leaving marks on it.
    const warnings: string[] = [];
    const report: AgentReporter = async (update) => {
      if (update.warning && warnings.length < MAX_RUN_WARNINGS) warnings.push(update.warning);
      try {
        await this.prisma.agentRun.updateMany({
          where: { id: runId, status: 'running' },
          data: {
            ...(update.stage === undefined ? {} : { stage: update.stage }),
            ...(update.progress === undefined
              ? {}
              : { progress: Math.min(1, Math.max(0, update.progress)) }),
            ...(update.warning === undefined ? {} : { warnings }),
          },
        });
      } catch (error) {
        // A heartbeat that cannot be written is not a reason to lose the work
        // the run has already done (the ActivityService.record rule).
        this.logger.warn(`Agent run ${runId} could not record progress: ${String(error)}`);
      }
    };

    await withLocale(asLocale(row.locale), async () => {
      try {
        // The run's owner as a real principal, including the dev/MCP stub
        // accommodation. Shared with the workflow processor, which needs the
        // identical rule (docs/features/20).
        const principal = await this.access.principalFor(
          row.createdBy,
          asLocale(row.locale) as Locale,
        );

        // Exactly the check an HTTP request makes, with the owner's own role.
        await this.access.requireRole(principal, row.workspaceId, 'viewer');

        // Budgets are checked here too, not only at enqueue: an unattended run
        // can sit in the queue long enough for the month's quota to go.
        await this.usage.assertWithinBudget(row.workspaceId, row.createdBy);

        const agent = await this.registry.resolve(row.workspaceId, row.agentKey);
        if (!agent.enabled) throw new Error(t('error.agent.disabled', { key: row.agentKey }));
        if (agent.tierUnmet) await report({ warning: t('agent.warning.tierUnmet', { tier: agent.minTier! }) });

        await this.events.publish({
          type: 'agent.run.started',
          workspaceId: row.workspaceId,
          subjectId: row.id,
          ...runFrameAddress(row),
        });

        const result = await this.executor.run(row, agent, principal, report);

        // Guarded, where this used to be a plain `update`.
        //
        // `requeueStuck` sets a stale run back to 'pending' — exactly the state
        // the retry's guarded claim looks for — so a second execution can be
        // running while this one finishes. With an unguarded write both
        // completed and the last writer won, which meant the reader saw
        // whichever of two executions happened to end second. If the row is no
        // longer 'running', the sweeper gave it away and ours is the stale copy.
        const settled = await this.prisma.agentRun.updateMany({
          where: { id: runId, status: 'running' },
          data: {
            status: 'succeeded',
            summary: result.summary,
            findings: result.findings as unknown as object,
            ...(result.details ? { details: result.details as unknown as object } : {}),
            warnings,
            stage: null,
            progress: 1,
            finishedAt: new Date(),
          },
        });
        if (settled.count !== 1) {
          this.logger.warn(`Agent run ${runId} finished after being re-queued; its result is discarded.`);
          return;
        }
        await this.events.publish({
          type: 'agent.run.succeeded',
          workspaceId: row.workspaceId,
          subjectId: row.id,
          ...runFrameAddress(row),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Agent run ${runId} failed: ${message}`);
        // Guarded for the same reason, and it matters more here: a superseded
        // execution failing must not mark a run failed that a retry is still
        // working on, or the reader is told the run is dead while it runs.
        const settled = await this.prisma.agentRun.updateMany({
          where: { id: runId, status: 'running' },
          data: {
            status: 'failed',
            error: message.slice(0, 2_000),
            warnings,
            stage: null,
            finishedAt: new Date(),
          },
        });
        if (settled.count !== 1) return;
        await this.events.publish({
          type: 'agent.run.failed',
          workspaceId: row.workspaceId,
          subjectId: row.id,
          ...runFrameAddress(row),
        });
      }
    });
  }
}
