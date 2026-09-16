import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Locale } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../auth/access.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { withLocale } from '../i18n/t.js';
import { asLocale } from '../i18n/locale.js';
import { AGENT_QUEUE, MAX_RUN_WARNINGS } from './agent.constants.js';
import { AgentExecutor, type AgentReporter } from './agent.executor.js';
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
  ) {
    super();
  }

  async process(job: Job<{ runId: string }>): Promise<void> {
    const runId = job.data.runId;
    const row = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!row) return;
    if (row.status === 'cancelled' || row.status === 'succeeded') return;

    // Guarded claim: two workers racing a re-delivered job never ask the model
    // the same question twice (the WorkflowRunnerService.claim pattern).
    //
    // The progress fields are reset here rather than left alone: a run reaching
    // this line for the second time is a retry, and inheriting the dead
    // execution's stage would have the row claim to be somewhere it is not.
    const claimed = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: 'pending' },
      data: { status: 'running', startedAt: new Date(), stage: null, progress: 0, warnings: [] },
    });
    if (claimed.count !== 1) return;

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
        if (!agent.enabled) throw new Error(`Agent "${row.agentKey}" is disabled.`);

        await this.events.publish({
          type: 'agent.run.started',
          workspaceId: row.workspaceId,
          subjectId: row.id,
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
        });
      }
    });
  }
}
