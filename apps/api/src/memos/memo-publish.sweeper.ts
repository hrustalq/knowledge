import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { AgentRun, Memo } from '@prisma/client';
import type { AgentFinding } from '@knowledge/contracts';
import { AgentFindingsService } from '../ai/agent-findings.service.js';
import { AccessService } from '../auth/access.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { asLocale } from '../i18n/locale.js';
import { t, withLocale } from '../i18n/t.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const SWEEP_INTERVAL_MS = 15_000;
const BATCH = 5;

/**
 * Opens a memo's kept proposals as merge requests once its `secretary` run
 * has finished (#551, docs/features/68) — `ScribePublishSweeper`'s shape, for
 * its reasons: opening a merge request needs `AgentFindingsService`, which
 * never loads in the worker, and it is the uploader's act, so it happens
 * where their principal can be rebuilt and their editor role checked now. It
 * doubles as recovery for a run that finished while the API was down.
 *
 * Each memo is published **at most once**, claimed by stamping
 * `published_at` in one guarded statement before anything is written. A
 * proposal that fails to open stays on the run, where its owner can still
 * propose it by hand.
 */
@Injectable()
export class MemoPublishSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoPublishSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly findings: AgentFindingsService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly events: EventsPublisher,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    // Back-pressure: never a second sweep while one is in flight.
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT m.id FROM memos m
          JOIN agent_runs r ON r.id = m.agent_run_id
         WHERE m.status = 'analysing'
           AND m.published_at IS NULL
           AND r.status IN ('succeeded', 'failed', 'cancelled')
         ORDER BY r.finished_at ASC NULLS LAST
         LIMIT ${BATCH}
      `;
      for (const { id } of due) {
        const claimed = await this.prisma.memo.updateMany({
          where: { id, status: 'analysing', publishedAt: null },
          data: { publishedAt: new Date() },
        });
        if (claimed.count === 0) continue;
        const memo = await this.prisma.memo.findUnique({ where: { id } });
        const run = memo?.agentRunId ? await this.prisma.agentRun.findUnique({ where: { id: memo.agentRunId } }) : null;
        if (!memo || !run) continue;
        await withLocale(asLocale(memo.locale), () => this.publish(memo, run)).catch((error: unknown) =>
          this.fail(memo, (error as Error).message),
        );
      }
    } catch (error) {
      this.logger.warn(`Memo publish sweep failed (non-fatal): ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async publish(memo: Memo, run: AgentRun): Promise<void> {
    if (run.status !== 'succeeded') {
      await this.fail(memo, run.error ?? t('error.memo.analysisFailed'));
      return;
    }
    const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    const pending = findings.flatMap((f, index) => (f.draft && !f.mergeRequestId ? [index] : []));
    let opened = 0;
    if (pending.length > 0) {
      const principal = await this.access.principalFor(memo.createdBy, asLocale(memo.locale));
      await this.access.requireRole(principal, memo.workspaceId, 'editor');
      for (const index of pending) {
        try {
          if (findings[index]!.documentIds[0]) await this.findings.propose(memo.workspaceId, run.id, index, principal);
          else await this.findings.proposePage(memo.workspaceId, run.id, index, principal, { projectId: memo.projectId });
          opened++;
        } catch (error) {
          this.logger.warn(`Memo ${memo.id} proposal ${index} was not opened: ${(error as Error).message}`);
        }
      }
    }
    await this.prisma.memo.update({ where: { id: memo.id }, data: { status: 'done', stage: null, error: null } });
    await this.tell(memo, 'memo.done', { proposed: opened, dropped: Array.isArray(memo.dropped) ? memo.dropped.length : 0 });
  }

  /** Back to `failed` at the analysis step, with the claim released so Retry can publish again. */
  private async fail(memo: Memo, message: string): Promise<void> {
    this.logger.warn(`Memo ${memo.id} analysis did not publish: ${message}`);
    await this.prisma.memo.update({
      where: { id: memo.id },
      data: { status: 'failed', stage: 'analysing', error: message.slice(0, 1000), publishedAt: null },
    });
    await this.tell(memo, 'memo.failed', {});
  }

  /** The uploader alone — the only person who may open the memo the row links to. */
  private async tell(memo: Memo, type: 'memo.done' | 'memo.failed', counts: Record<string, number>): Promise<void> {
    const delivered = await this.notifications.notify({
      workspaceId: memo.workspaceId,
      userIds: [memo.createdBy],
      type,
      reason: 'author',
      actor: null,
      title: memo.title,
      metadata: { memoId: memo.id, ...counts },
    });
    await this.events.announce(memo.workspaceId, delivered);
  }
}
