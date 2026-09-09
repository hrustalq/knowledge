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
import { AGENT_QUEUE } from './agent.constants.js';
import { AgentExecutor } from './agent.executor.js';
import { AgentRegistryService } from './agent-registry.service.js';
import { DEV_PRINCIPAL, type Principal } from '../auth/principal.js';

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

  /**
   * A run's owner as a real principal. A disabled or deleted owner fails the
   * run — it never falls back to something with more authority.
   */
  private async rehydrate(userId: string, locale: Locale): Promise<Principal> {
    const owner = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!owner || owner.disabledAt) {
      throw new Error('The user this run belongs to no longer exists or is disabled.');
    }
    return {
      userId: owner.id,
      email: owner.email,
      displayName: owner.displayName,
      mode: 'api-key',
      isAdmin: owner.isAdmin,
      locale,
    };
  }

  async process(job: Job<{ runId: string }>): Promise<void> {
    const runId = job.data.runId;
    const row = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!row) return;
    if (row.status === 'cancelled' || row.status === 'succeeded') return;

    // Guarded claim: two workers racing a re-delivered job never ask the model
    // the same question twice (the WorkflowRunnerService.claim pattern).
    const claimed = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: 'pending' },
      data: { status: 'running', startedAt: new Date() },
    });
    if (claimed.count !== 1) return;

    await withLocale(asLocale(row.locale), async () => {
      try {
        // In AUTH_MODE=none the caller IS the dev principal, whose id is the
        // zeros stub and which has no `users` row — so rehydrating would fail
        // every run in the default dev setup. The same accommodation the merge
        // gates make for this identity (CLAUDE.md), and it changes nothing
        // under api-key mode, where no real user can hold that id.
        const principal =
          row.createdBy === DEV_PRINCIPAL.userId
            ? DEV_PRINCIPAL
            : await this.rehydrate(row.createdBy, asLocale(row.locale) as Locale);

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

        const result = await this.executor.run(row, agent);

        await this.prisma.agentRun.update({
          where: { id: runId },
          data: {
            status: 'succeeded',
            summary: result.summary,
            findings: result.findings as unknown as object,
            finishedAt: new Date(),
          },
        });
        await this.events.publish({
          type: 'agent.run.succeeded',
          workspaceId: row.workspaceId,
          subjectId: row.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Agent run ${runId} failed: ${message}`);
        await this.prisma.agentRun.update({
          where: { id: runId },
          data: { status: 'failed', error: message.slice(0, 2_000), finishedAt: new Date() },
        });
        await this.events.publish({
          type: 'agent.run.failed',
          workspaceId: row.workspaceId,
          subjectId: row.id,
        });
      }
    });
  }
}
