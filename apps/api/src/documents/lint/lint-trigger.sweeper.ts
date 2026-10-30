import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { AgentRunInput, Locale, MergeRequestCheckReason } from '@knowledge/contracts';
import type { Env } from '../../config/env.js';
import { AgentProducer } from '../../agents/agent.producer.js';
import { enabledRules } from '../../agents/lint.js';
import { AiSkillsService } from '../../ai/ai-skills.service.js';
import { AiUsageService } from '../../ai/ai-usage.service.js';
import { AccessService } from '../../auth/access.service.js';
import { asLocale } from '../../i18n/locale.js';
import { t } from '../../i18n/t.js';
import { PermissionService } from '../../permissions/permission.service.js';
import { visibilityWhere, WORKSPACE_AUDIENCE } from '../../permissions/access-scope.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LintChecksService } from './lint-checks.service.js';
import { LINT_AGENT_KEY } from './lint-check.js';
import { sourcePages } from '../mr-pages.js';

const SWEEP_INTERVAL_MS = 30_000;
/** Heads looked at per tick. */
const BATCH = 20;

/** A page of an open merge request whose source head has no lint check yet (#636: one check per page). */
export interface LintCandidate {
  mergeRequestId: string;
  authorId: string;
  workspaceId: string;
  projectId: string;
  documentId: string;
  headRevisionId: string;
}

/**
 * Starts the style lint of merge request heads (#74, phase 2).
 *
 * A sweeper rather than a hook in revision writes: it covers merge requests
 * opened by people, agents, MCP clients, workflows and connectors alike, and a
 * head pushed while the API was down is linted when it comes back. No cron —
 * a fixed tick, never a second sweep while one is in flight.
 *
 * The rules that keep a busy workspace from becoming a busy bill:
 *
 * - **A head is linted once.** `(merge request, kind, head)` is unique, and the
 *   insert is the claim: two API replicas sweeping together create one check.
 * - **A newer head supersedes a waiting one.** The older check is `skipped`
 *   and its run cancelled before the model sees it.
 * - **A workspace holds at most `LINT_MAX_PENDING_PER_WORKSPACE` waiting
 *   checks**; past it a head simply waits for a later tick.
 * - **No styleguide, no model call** — the check is recorded as skipped.
 *
 * The run is the merge request author's: their role caps it and their budget
 * pays for it, checked here and again by the processor.
 */
@Injectable()
export class LintTriggerSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LintTriggerSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly checks: LintChecksService,
    private readonly skills: AiSkillsService,
    private readonly usage: AiUsageService,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
    private readonly producer: AgentProducer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    // A deployment that lints nothing pays nothing, not even the query.
    if (this.checks.ceiling === 'off') return;
    this.running = true;
    try {
      for (const candidate of await this.candidates()) {
        try {
          await this.check(candidate);
        } catch (error) {
          this.logger.warn(`Lint check of merge request ${candidate.mergeRequestId} failed to start: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Lint trigger sweep failed (non-fatal): ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Pages of open, ready merge requests whose head has no check, live, where
   * the policy could be on: a scope that says `off` and a disabled linter are
   * filtered here, so they cannot fill the batch tick after tick. The policy
   * is resolved properly in `check`; this is only the prefilter.
   */
  private candidates(): Promise<LintCandidate[]> {
    return this.prisma.$queryRaw<LintCandidate[]>`
      SELECT mr.id AS "mergeRequestId", mr.author_id AS "authorId", d.workspace_id AS "workspaceId",
             d.project_id AS "projectId", d.id AS "documentId", sb.head_revision_id AS "headRevisionId"
        FROM merge_requests mr
        JOIN document_branches s0 ON s0.id = mr.source_branch_id
        -- Every page the merge request carries, as sourcePages derives them (#636).
        JOIN document_branches sb ON sb.id = s0.id OR (
               sb.project_branch_id = s0.project_branch_id
               AND EXISTS (SELECT 1 FROM document_revisions r WHERE r.branch_id = sb.id AND r.status <> 'draft'))
        JOIN documents d ON d.id = sb.document_id
        LEFT JOIN workspace_settings ws ON ws.workspace_id = d.workspace_id
        LEFT JOIN projects p ON p.id = d.project_id
       WHERE mr.status = 'open'
         AND NOT mr.is_draft
         AND sb.head_revision_id IS NOT NULL
         AND d.archived_at IS NULL
         AND COALESCE(p.lint_policy, ws.lint_policy, ${this.checks.ceiling}) <> 'off'
         AND NOT EXISTS (
           SELECT 1 FROM ai_agents a
            WHERE a.workspace_id = d.workspace_id AND a.key = ${LINT_AGENT_KEY} AND a.enabled = false
         )
         AND NOT EXISTS (
           SELECT 1 FROM merge_request_checks c
            WHERE c.merge_request_id = mr.id AND c.kind = 'lint' AND c.head_revision_id = sb.head_revision_id
         )
       ORDER BY mr.created_at ASC
       LIMIT ${BATCH}
    `;
  }

  /**
   * Check one head: record why not, or queue the run. Returns the check id, or
   * null when nothing was recorded (policy off, back-pressure, a lost race).
   */
  async check(c: LintCandidate): Promise<string | null> {
    const policy = await this.checks.policyFor(c.workspaceId, c.projectId);
    if (policy.effective === 'off') return null;

    const styleguide = await this.skills.effectiveStyleguide(c.workspaceId, c.projectId);
    if (!styleguide || enabledRules(styleguide.rules).length === 0) {
      return this.record(c, { status: 'skipped', reason: 'no-styleguide', styleguideId: styleguide?.row.id ?? null });
    }
    const styleguideId = styleguide.row.id;

    // The run acts as the author. One who can no longer read the workspace has
    // nobody to act as — the drift check's ownerless-connector rule.
    const author = await this.prisma.user.findUnique({ where: { id: c.authorId }, select: { locale: true } });
    const locale = asLocale(author?.locale) as Locale;
    let principal;
    try {
      principal = await this.access.principalFor(c.authorId, locale);
      await this.access.requireRole(principal, c.workspaceId, 'viewer');
    } catch {
      return this.record(c, { status: 'skipped', reason: 'author-unavailable', styleguideId });
    }
    // A run's findings quote the page and are listed to every member, so the
    // page must be one every member may read (#76) — the audience clamp every
    // background agent reads under. The executor asks again before it reads.
    const audience = await this.permissions.audienceScope(await this.permissions.scopeFor(principal, c.workspaceId), WORKSPACE_AUDIENCE);
    const open = await this.prisma.document.count({
      where: { id: c.documentId, AND: [visibilityWhere(audience)] },
    });
    if (open === 0) return this.record(c, { status: 'skipped', reason: 'restricted', styleguideId });
    try {
      await this.usage.assertWithinBudget(c.workspaceId, c.authorId);
    } catch {
      return this.record(c, { status: 'error', reason: 'budget', styleguideId });
    }

    const max = this.config.get('LINT_MAX_PENDING_PER_WORKSPACE', { infer: true });
    const waiting = await this.prisma.mergeRequestCheck.count({
      where: { workspaceId: c.workspaceId, kind: 'lint', status: 'pending' },
    });
    if (waiting >= max) return null;

    const checkId = await this.record(c, { status: 'pending', reason: null, styleguideId });
    if (!checkId) return null;
    await this.supersede(c, checkId);

    const override = await this.prisma.aiAgent.findUnique({
      where: { workspaceId_key: { workspaceId: c.workspaceId, key: LINT_AGENT_KEY } },
      select: { id: true },
    });
    const input: AgentRunInput = {
      lint: { mergeRequestId: c.mergeRequestId, headRevisionId: c.headRevisionId, checkId },
    };
    const run = await this.prisma.agentRun.create({
      data: {
        workspaceId: c.workspaceId,
        agentKey: LINT_AGENT_KEY,
        agentId: override?.id ?? null,
        trigger: 'merge-request',
        createdBy: c.authorId,
        locale,
        input: input as Prisma.InputJsonValue,
      },
    });
    await this.prisma.mergeRequestCheck.update({ where: { id: checkId }, data: { agentRunId: run.id } });
    await this.producer.enqueue(run.id);
    return checkId;
  }

  /**
   * Insert the head's check. The unique key makes this the claim: a row that
   * already exists means somebody else checked this head, and nothing is done.
   */
  private async record(
    c: LintCandidate,
    fields: { status: 'pending' | 'skipped' | 'error'; reason: MergeRequestCheckReason | null; styleguideId: string | null },
  ): Promise<string | null> {
    const id = randomUUID();
    const inserted = await this.prisma.mergeRequestCheck.createMany({
      data: [
        {
          id,
          workspaceId: c.workspaceId,
          mergeRequestId: c.mergeRequestId,
          kind: 'lint',
          headRevisionId: c.headRevisionId,
          ...fields,
        },
      ],
      skipDuplicates: true,
    });
    return inserted.count === 1 ? id : null;
  }

  /** Older heads of the same page still waiting: skipped, and their runs cancelled before they cost anything. */
  private async supersede(c: LintCandidate, keepId: string): Promise<void> {
    const waiting = await this.prisma.mergeRequestCheck.findMany({
      where: { mergeRequestId: c.mergeRequestId, kind: 'lint', status: 'pending', id: { not: keepId } },
      select: { id: true, agentRunId: true, headRevisionId: true },
    });
    if (waiting.length === 0) return;
    const samePage = new Set(
      (
        await this.prisma.documentRevision.findMany({
          where: { id: { in: waiting.map((w) => w.headRevisionId) }, documentId: c.documentId },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    const stale = waiting.filter((w) => samePage.has(w.headRevisionId));
    if (stale.length === 0) return;
    await this.prisma.mergeRequestCheck.updateMany({
      where: { id: { in: stale.map((s) => s.id) }, status: 'pending' },
      data: { status: 'skipped', reason: 'superseded' },
    });
    const runIds = stale.map((s) => s.agentRunId).filter((id): id is string => !!id);
    if (runIds.length) {
      await this.prisma.agentRun.updateMany({
        where: { id: { in: runIds }, status: 'pending' },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
    }
  }

  /**
   * Lint the current heads again (POST …/checks/lint): each page's finished
   * check is dropped so its head can be claimed afresh, and the first new
   * check is returned. A page whose check is still waiting or running is left
   * alone (409 when that is every page), and so is a merge request lint is off for.
   */
  async relint(mergeRequestId: string): Promise<string> {
    const mr = await this.prisma.mergeRequest.findUnique({
      where: { id: mergeRequestId },
      include: { sourceBranch: true, document: { select: { workspaceId: true, projectId: true } } },
    });
    if (!mr) throw new NotFoundException(t('error.mergeRequest.notFound', { id: mergeRequestId }));
    const pages = (await sourcePages(this.prisma, mr.sourceBranch)).filter((b) => b.headRevisionId);
    if (mr.status !== 'open' || pages.length === 0) throw new BadRequestException(t('error.lint.notOpen'));

    const policy = await this.checks.policyFor(mr.document.workspaceId, mr.document.projectId);
    if (policy.effective === 'off') throw new BadRequestException(t('error.lint.off'));

    let first: string | null = null;
    let waitingId: string | null = null;
    for (const page of pages) {
      const head = page.headRevisionId!;
      const waiting = await this.prisma.mergeRequestCheck.findFirst({
        where: { mergeRequestId, kind: 'lint', headRevisionId: head, status: 'pending' },
        select: { id: true },
      });
      if (waiting) {
        waitingId ??= waiting.id;
        continue;
      }
      await this.prisma.mergeRequestCheck.deleteMany({
        where: { mergeRequestId, kind: 'lint', headRevisionId: head, status: { not: 'pending' } },
      });
      const checkId = await this.check({
        mergeRequestId,
        authorId: mr.authorId,
        workspaceId: mr.document.workspaceId,
        projectId: mr.document.projectId,
        documentId: page.documentId,
        headRevisionId: head,
      });
      first ??= checkId;
    }
    if (first) return first;
    if (waitingId) {
      throw new ConflictException({ statusCode: 409, message: t('error.lint.running'), reason: 'lint.running', checkId: waitingId });
    }
    throw new ConflictException({ statusCode: 409, message: t('error.lint.busy'), reason: 'lint.busy' });
  }
}
