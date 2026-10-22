import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentRun, Connector, ConnectorWorkItem } from '@prisma/client';
import type { AgentFinding, AgentRunInput } from '@knowledge/contracts';
import type { Env } from '../../config/env.js';
import { AgentFindingsService } from '../../ai/agent-findings.service.js';
import { AccessService } from '../../auth/access.service.js';
import { asLocale } from '../../i18n/locale.js';
import { t, withLocale } from '../../i18n/t.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { TrackerBodyLine } from '../adapters/tracker.js';
import { TrackerRegistry } from '../tracker-registry.service.js';

const SWEEP_INTERVAL_MS = 15_000;
const BATCH = 5;
/** A run older than this is left as it is: its owner can still propose its findings by hand. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Opens a finished scribe run's drafts as merge requests and says so on the
 * ticket (#433) — `ComponentDraftSweeper`'s shape, for its reasons: opening a
 * merge request needs `AgentFindingsService`, which never loads in the worker,
 * and a comment on a tracker is an outward act the worker does not make. It
 * doubles as recovery for a run that finished while the API was down.
 *
 * Each run is published **at most once**, claimed by stamping
 * `input.publishedAt` before anything is written, so the ticket gets one
 * comment however many sweeps race. Everything is attributed to the run's
 * owner — the trigger's — whose editor role is checked again now. A draft that
 * fails to open stays on the run, where its owner can still propose it.
 */
@Injectable()
export class ScribePublishSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScribePublishSweeper.name);
  private readonly webBaseUrl: string;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly findings: AgentFindingsService,
    private readonly access: AccessService,
    private readonly trackers: TrackerRegistry,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

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
      const since = new Date(Date.now() - MAX_AGE_MS);
      const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM agent_runs
         WHERE agent_key = 'scribe'
           AND status = 'succeeded'
           AND finished_at >= ${since}
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
          this.logger.warn(`Publishing scribe run ${id} failed: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Scribe sweep failed (non-fatal): ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async publish(run: AgentRun): Promise<void> {
    const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    const pending = findings.flatMap((f, index) => (f.draft && !f.mergeRequestId ? [index] : []));
    if (pending.length === 0) return;

    const input = (run.input ?? {}) as AgentRunInput;
    const item = input.event?.subjectId
      ? await this.prisma.connectorWorkItem.findFirst({ where: { id: input.event.subjectId, workspaceId: run.workspaceId } })
      : null;
    const row = item ? await this.prisma.connector.findFirst({ where: { id: item.connectorId, workspaceId: run.workspaceId } }) : null;
    if (!item || !row) return;

    const principal = await this.access.principalFor(run.createdBy, asLocale(run.locale));
    await this.access.requireRole(principal, run.workspaceId, 'editor');
    const place = await this.placeFor(run.workspaceId, item, row);

    const opened: TrackerBodyLine[] = [];
    for (const index of pending) {
      try {
        const finding = findings[index];
        const { mergeRequestId, title } = finding.documentIds[0]
          ? await this.findings.propose(run.workspaceId, run.id, index, principal)
          : await this.findings.proposePage(run.workspaceId, run.id, index, principal, place);
        opened.push({ text: title, link: `${this.webBaseUrl}/merge-requests/${mergeRequestId}` });
      } catch (error) {
        this.logger.warn(`Scribe run ${run.id} draft ${index} was not opened: ${(error as Error).message}`);
      }
    }
    if (opened.length === 0) return;

    const tracker = this.trackers.trackerFor(row);
    if (!tracker) return;
    await tracker.comment(row, item, [
      { text: t('agent.scribeRun.ticketComment') },
      ...opened,
      { text: t('agent.scribeRun.ticketCommentEnd') },
    ]);
  }

  /**
   * Where a new page goes: beside the page the ticket is anchored on; else the
   * project whose tracker route sends this Jira project's tickets (or the one
   * route on the connector); else the connector's own destination.
   */
  async placeFor(
    workspaceId: string,
    item: Pick<ConnectorWorkItem, 'documentId' | 'externalKey'>,
    row: Pick<Connector, 'id' | 'projectId' | 'parentId'>,
  ): Promise<{ projectId: string; parentId: string | null }> {
    const page = item.documentId
      ? await this.prisma.document.findFirst({
          where: { id: item.documentId, workspaceId },
          select: { projectId: true, parentId: true },
        })
      : null;
    if (page) return { projectId: page.projectId, parentId: page.parentId };
    const routes = await this.prisma.projectTrackerRoute.findMany({ where: { workspaceId, connectorId: row.id } });
    const key = item.externalKey?.split('-')[0];
    const route = routes.find((r) => key && r.externalProject === key) ?? (routes.length === 1 ? routes[0] : null);
    if (route) return { projectId: route.projectId, parentId: null };
    return { projectId: row.projectId, parentId: row.parentId };
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
