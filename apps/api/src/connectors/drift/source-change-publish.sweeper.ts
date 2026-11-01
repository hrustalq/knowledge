import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { AgentRun } from '@prisma/client';
import { sourceMisalignment, type AgentFinding, type AgentRunDetails, type AgentRunInput, type Locale } from '@knowledge/contracts';
import { AgentFindingsService } from '../../ai/agent-findings.service.js';
import { AccessService } from '../../auth/access.service.js';
import { asLocale } from '../../i18n/locale.js';
import { t, withLocale } from '../../i18n/t.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { VerificationService } from '../../verification/verification.service.js';
import { pagesToFlag } from './drift-flags.js';
import { DRIFT_AGENT_KEY } from './drift-trigger.service.js';

const SWEEP_INTERVAL_MS = 15_000;
const BATCH = 5;
/** A run older than this is history, not news — `DriftPublishSweeper`'s rule. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Publishes a finished source-change check (#674, phase 5b): the sentinel's
 * verdicts on the pages linking a source-backed page's new version.
 *
 * - Each page it found wrong, and each it left unchecked (past the cap, or
 *   restricted), is flagged `requested`, which tells its owner. A page
 *   verified after the run started, or already `outdated`, is left alone.
 * - In `propose` mode a drafted fix also opens as a merge request, through the
 *   same `AgentFindingsService` the Propose button calls, as the run's owner —
 *   the connector's. An owner who is no longer an editor proposes nothing; the
 *   flags still go out.
 *
 * API-side for the drift publisher's reason: a merge request needs a
 * principal. Each run is claimed once (`input.publishedAt`) before anything is
 * written, and a run that finished while the API was down is published when it
 * returns, inside `MAX_AGE_MS`.
 */
@Injectable()
export class SourceChangePublishSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SourceChangePublishSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly findings: AgentFindingsService,
    private readonly access: AccessService,
    private readonly verification: VerificationService,
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
        SELECT id FROM agent_runs
         WHERE agent_key = ${DRIFT_AGENT_KEY}
           AND status = 'succeeded'
           AND finished_at >= ${new Date(Date.now() - MAX_AGE_MS)}
           AND input -> 'sourceChange' IS NOT NULL
           AND COALESCE(input ->> 'publishedAt', '') = ''
         ORDER BY finished_at ASC
         LIMIT ${BATCH}
      `;
      for (const { id } of due) {
        if (!(await this.claim(id))) continue;
        const run = await this.prisma.agentRun.findUnique({ where: { id } });
        if (!run) continue;
        try {
          await withLocale(asLocale(run.locale), () => this.publish(run));
        } catch (error) {
          this.logger.warn(`Publishing source change check ${id} failed: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Source change publish sweep failed (non-fatal): ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async publish(run: AgentRun): Promise<void> {
    const change = ((run.input ?? {}) as AgentRunInput).sourceChange;
    if (!change) return;
    const [link, source] = await Promise.all([
      this.prisma.connectorLink.findFirst({
        where: { documentId: change.documentId, connector: { kind: 'web', workspaceId: run.workspaceId } },
        select: { connector: { select: { config: true } } },
      }),
      this.prisma.document.findUnique({ where: { id: change.documentId }, select: { title: true } }),
    ]);
    // Unlinked since the check was queued: the page is no longer a source's.
    if (!link || !source) return;

    const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    const unchecked = ((run.details ?? {}) as AgentRunDetails).sourceUnchecked ?? [];
    const flags: Array<[string, string]> = [
      ...[...pagesToFlag(findings)].map(([id, f]): [string, string] => [id, (f.detail || f.title).replace(/\s+/g, ' ').trim()]),
      ...unchecked.map((u): [string, string] => [
        u.documentId,
        t(u.reason === 'cap' ? 'connector.sourceChange.notChecked' : 'connector.sourceChange.notCheckedRestricted'),
      ]),
    ];
    // Flags first, so a proposal that fails does not also silence the page. A
    // page the deterministic pass flagged keeps its note: it names what went.
    const passFlagged = new Set(change.flagged ?? []);
    for (const [documentId, changes] of flags) {
      if (passFlagged.has(documentId)) continue;
      await this.verification
        .requestVerification(documentId, {
          actorId: run.createdBy,
          note: t('connector.sourceChangedNote', { title: source.title, changes }),
          source: { kind: 'source', by: run.createdBy, runId: run.id },
          unlessVerifiedAfter: run.createdAt,
          keepOutdated: true,
        })
        .catch((error: unknown) => this.logger.warn(`source change flag on page ${documentId} skipped: ${(error as Error).message}`));
    }

    if (sourceMisalignment(link.connector.config) !== 'propose' || !findings.some((f) => f.draft)) return;
    const principal = await this.editorPrincipal(run);
    if (!principal) return;
    for (const [index, finding] of findings.entries()) {
      if (!finding.draft || finding.mergeRequestId) continue;
      await this.findings
        .propose(run.workspaceId, run.id, index, principal)
        .catch((error: unknown) => this.logger.warn(`source change proposal for "${finding.title}" failed: ${(error as Error).message}`));
    }
  }

  /** The run's owner as an editor, or null with a log line. */
  private async editorPrincipal(run: AgentRun) {
    try {
      const principal = await this.access.principalFor(run.createdBy, asLocale(run.locale) as Locale);
      await this.access.requireRole(principal, run.workspaceId, 'editor');
      return principal;
    } catch (error) {
      this.logger.warn(`source change proposals skipped for run ${run.id}: ${(error as Error).message}`);
      return null;
    }
  }

  /** Stamp `publishedAt` if nobody has. One statement, so two sweeps cannot both win. */
  private async claim(runId: string): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE agent_runs
         SET input = jsonb_set(COALESCE(input, '{}'::jsonb), '{publishedAt}', to_jsonb(${new Date().toISOString()}::text), true)
       WHERE id = ${runId}::uuid
         AND COALESCE(input ->> 'publishedAt', '') = ''
    `;
    return affected > 0;
  }
}
