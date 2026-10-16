import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { KnowledgeCapture } from '@prisma/client';
import {
  accessRank,
  captureStateFor,
  isWebSource,
  type AssistantSource,
  type BulkRejectCapturesRequest,
  type BulkRejectCapturesResponse,
  type CaptureApiKey,
  type CaptureInfo,
  type CaptureResult,
  type CaptureStatus,
  type GlossaryCapturePayload,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { visibilityWhere } from '../permissions/access-scope.js';
import { GlossaryService } from '../glossary/glossary.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { asLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';
import { CAPTURE_MAX_ATTEMPTS, CaptureService } from './capture.service.js';

/** Stranded captures re-driven per tick, oldest first; the rest wait for the next one. */
const SWEEP_BATCH = 20;

/**
 * The person's side of agent-session captures (issue #73, phase 3): reading
 * one, approving a term out of the inbox, rejecting what waits there, saving
 * an assistant reply, and re-driving what a crash stranded.
 *
 * API-only beside `CaptureService` (which MCP also loads): approving writes a
 * glossary term as the approver, and the sweeper — the one caller of
 * `sweepStranded` — is a timer that must never start in an MCP process.
 *
 * Only a term is approved here. A page or relation capture is a merge request
 * from the moment it is proposed, and the merge request is where it is
 * reviewed, merged or closed; the inbox never offers a second door to the
 * same decision.
 */
@Injectable()
export class CaptureInboxService {
  private readonly logger = new Logger(CaptureInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly captures: CaptureService,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
    private readonly glossary: GlossaryService,
    private readonly activity: ActivityService,
    private readonly mergeRequests: MergeRequestsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * One capture. One the caller could not find in the list — a project kept
   * from them, or a page they may not open — is a 404 here as well, so the id
   * says nothing the list would not.
   */
  async get(id: string, principal: Principal): Promise<CaptureInfo> {
    return this.captures.info(await this.visibleRow(id, principal));
  }

  /**
   * A staged term becomes a glossary entry, `source: 'captured'`, written by
   * the approver. The row is settled and the term created in one
   * transaction: the guarded update row-locks, so a second approve waits and
   * then finds nothing staged, and a term that fails to create (a name taken
   * since) leaves the capture staged for a reject.
   */
  async approve(id: string, principal: Principal): Promise<CaptureInfo> {
    const row = await this.visibleRow(id, principal);
    if (row.kind !== 'glossary') {
      throw new ConflictException({ statusCode: 409, message: t('error.capture.notApprovable'), reason: 'capture-not-approvable' });
    }
    if (row.status !== 'staged') throw this.notStaged(row);
    // Staged but not yet checked against the glossary: its dedupe is still running.
    if (row.outcome !== 'glossary') {
      throw new ConflictException({ statusCode: 409, message: t('error.capture.inFlight'), reason: 'capture-in-flight' });
    }

    const payload = row.payload as unknown as GlossaryCapturePayload;
    const termId = await this.prisma.withTransaction(async () => {
      const settled = await this.prisma.knowledgeCapture.updateMany({
        where: { id, status: 'staged', outcome: 'glossary' },
        data: { status: 'proposed', claimedAt: null, error: null },
      });
      if (settled.count !== 1) throw this.notStaged(await this.prisma.knowledgeCapture.findUniqueOrThrow({ where: { id } }));
      const term = await this.glossary.create(
        {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          term: payload.term,
          definition: payload.definition,
          ...(payload.aliases?.length ? { aliases: payload.aliases } : {}),
          ...(payload.documentId ? { documentId: payload.documentId } : {}),
          source: 'captured',
        },
        principal.userId,
      );
      await this.prisma.knowledgeCapture.update({ where: { id }, data: { glossaryTermId: term.termId } });
      return term.termId;
    });

    void this.activity.record({
      workspaceId: row.workspaceId,
      actor: principal.userId,
      action: 'capture.approved',
      projectId: row.projectId,
      subjectId: row.id,
      metadata: { kind: row.kind, title: row.title, glossaryTermId: termId },
    });
    return this.get(id, principal);
  }

  /**
   * A staged capture is turned down: a term in the inbox, or a page capture a
   * crash left staged. A proposed one points at its merge request instead —
   * closing that is the rejection, and its state follows. A capture someone
   * is proposing right now is refused rather than raced.
   */
  async reject(id: string, principal: Principal, reason?: string): Promise<CaptureInfo> {
    const row = await this.visibleRow(id, principal);
    if (row.status === 'proposed' && row.mergeRequestId) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.capture.useMergeRequest'),
        reason: 'capture-use-merge-request',
        mergeRequestId: row.mergeRequestId,
      });
    }
    if (row.status !== 'staged') throw this.notStaged(row);

    const stale = new Date(Date.now() - this.config.get('CAPTURE_STALE_MS', { infer: true }));
    const done = await this.prisma.knowledgeCapture.updateMany({
      where: { id, status: 'staged', OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }] },
      data: { status: 'rejected', claimedAt: null },
    });
    if (done.count !== 1) {
      throw new ConflictException({ statusCode: 409, message: t('error.capture.inFlight'), reason: 'capture-in-flight' });
    }
    void this.activity.record({
      workspaceId: row.workspaceId,
      actor: principal.userId,
      action: 'capture.rejected',
      projectId: row.projectId,
      ...(row.targetDocumentId ? { documentId: row.targetDocumentId } : {}),
      subjectId: row.id,
      metadata: { kind: row.kind, title: row.title, ...(reason?.trim() ? { reason: reason.trim().slice(0, 1_000) } : {}) },
    });
    return this.get(id, principal);
  }

  /**
   * The key `?apiKeyId=` narrows the inbox to, named for the filter chip
   * (issue #235). Your own key is yours to look up at any role; anyone else's
   * takes an editor, so a viewer cannot walk key ids to see who proposed what.
   * A key that is neither pinned here nor held by a member here, and never
   * captured here, is another tenant's: 403, the same answer as a key that
   * does not exist.
   */
  async keyIn(workspaceId: string, apiKeyId: string, principal: Principal): Promise<CaptureApiKey> {
    const key = await this.prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      select: { id: true, userId: true, workspaceId: true, name: true, prefix: true, revokedAt: true },
    });
    if (key?.userId !== principal.userId) await this.access.requireRole(principal, workspaceId, 'editor');
    // A key pinned elsewhere could never have captured here. An owner who has
    // since left still leaves their key's captures behind to clean up.
    const here =
      !!key &&
      (key.workspaceId === null || key.workspaceId === workspaceId) &&
      ((await this.prisma.workspaceMember.count({ where: { workspaceId, userId: key.userId } })) > 0 ||
        (await this.prisma.knowledgeCapture.count({ where: { workspaceId, apiKeyId } })) > 0);
    if (!key || !here) throw new ForbiddenException(t('error.capture.keyNotHere'));
    return { id: key.id, name: key.name, prefix: key.prefix, revoked: key.revokedAt !== null };
  }

  /**
   * Everything one key proposed that is still pending, turned down at once
   * (issue #235): its staged captures rejected with the single reject's
   * guarded update, and the open merge requests its captures opened closed as
   * the caller. Each capture still gets its own `capture.rejected` row.
   *
   * Only what the caller can see in the list is touched. A row someone is
   * proposing right now is skipped rather than raced, and a merge request on a
   * page the caller may read but not edit is left open; both are counted so
   * the answer adds up. Merged captures are left alone — undoing one is a
   * revert. `dryRun` counts the same rows and writes nothing.
   */
  async bulkReject(req: BulkRejectCapturesRequest, principal: Principal): Promise<BulkRejectCapturesResponse> {
    const { workspaceId, apiKeyId } = req;
    await this.keyIn(workspaceId, apiKeyId, principal);
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    const reason = req.reason?.trim() ? req.reason.trim().slice(0, 1_000) : undefined;
    const out: BulkRejectCapturesResponse = { rejected: 0, closed: 0, skippedInFlight: 0, skippedNoAccess: 0 };

    const candidates = await this.prisma.knowledgeCapture.findMany({
      where: { workspaceId, apiKeyId, OR: [{ status: 'staged' }, { status: 'proposed', mergeRequestId: { not: null } }] },
      orderBy: { createdAt: 'asc' },
    });
    const targets = [...new Set(candidates.map((r) => r.targetDocumentId).filter((id): id is string => !!id))];
    const visible = new Set(
      targets.length
        ? (await this.prisma.document.findMany({ where: { id: { in: targets }, AND: [visibilityWhere(scope)] }, select: { id: true } })).map(
            (d) => d.id,
          )
        : [],
    );
    const rows = candidates.filter((r) => !scope.denied.has(r.projectId) && (!r.targetDocumentId || visible.has(r.targetDocumentId)));
    const record = (row: KnowledgeCapture, extra: Record<string, unknown> = {}) =>
      void this.activity.record({
        workspaceId,
        actor: principal.userId,
        action: 'capture.rejected',
        projectId: row.projectId,
        ...(row.targetDocumentId ? { documentId: row.targetDocumentId } : {}),
        subjectId: row.id,
        metadata: { kind: row.kind, title: row.title, bulk: true, apiKeyId, ...extra, ...(reason ? { reason } : {}) },
      });

    const stale = new Date(Date.now() - this.config.get('CAPTURE_STALE_MS', { infer: true }));
    for (const row of rows.filter((r) => r.status === 'staged')) {
      if (req.dryRun) {
        if (row.claimedAt && row.claimedAt >= stale) out.skippedInFlight++;
        else out.rejected++;
        continue;
      }
      const done = await this.prisma.knowledgeCapture.updateMany({
        where: { id: row.id, status: 'staged', OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }] },
        data: { status: 'rejected', claimedAt: null },
      });
      if (done.count !== 1) {
        out.skippedInFlight++;
        continue;
      }
      out.rejected++;
      record(row);
    }

    // One merge request may carry more than one capture; it is closed once and each capture is recorded.
    const byMr = new Map<string, KnowledgeCapture[]>();
    for (const row of rows) {
      if (row.status !== 'proposed' || !row.mergeRequestId) continue;
      byMr.set(row.mergeRequestId, [...(byMr.get(row.mergeRequestId) ?? []), row]);
    }
    const open = byMr.size
      ? await this.prisma.mergeRequest.findMany({ where: { id: { in: [...byMr.keys()] }, status: 'open' }, select: { id: true, documentId: true } })
      : [];
    for (const mr of open) {
      const level = await this.permissions.levelFor(scope, { type: 'document', id: mr.documentId });
      if (accessRank(level) < accessRank('edit')) {
        out.skippedNoAccess++;
        continue;
      }
      if (!req.dryRun) {
        try {
          await this.mergeRequests.close(mr.id, principal.userId);
        } catch (err) {
          // Merged or closed since it was read: nothing left to turn down.
          if (err instanceof BadRequestException) continue;
          throw err;
        }
        for (const row of byMr.get(mr.id)!) record(row, { mergeRequestId: mr.id });
      }
      out.closed++;
    }
    return out;
  }

  /**
   * "Save to knowledge base" on an assistant reply: an `answer` capture whose
   * question is the user turn before the reply and whose citations are the
   * reply's own page sources (web sources are not pages). Everything after
   * that is `CaptureService.capture` — the same guards, dedupe and merge
   * request an agent's `knowledge_propose_answer` gets.
   */
  async fromAssistantMessage(
    messageId: string,
    body: { projectId?: string; title?: string },
    principal: Principal,
  ): Promise<CaptureResult> {
    const message = await this.prisma.assistantMessage.findUnique({
      where: { id: messageId },
      include: { thread: { select: { id: true, workspaceId: true } } },
    });
    if (!message) throw new NotFoundException(t('error.assistant.messageNotFoundById', { id: messageId }));
    if (message.role !== 'assistant') {
      throw new BadRequestException({ statusCode: 400, message: t('error.capture.messageNotAssistant'), reason: 'capture-not-assistant' });
    }
    // The tie-break is the (createdAt, id) order the thread is read in.
    const question = await this.prisma.assistantMessage.findFirst({
      where: { threadId: message.threadId, role: 'user', id: { not: message.id }, createdAt: { lte: message.createdAt } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { content: true },
    });
    const sources = (Array.isArray(message.sources) ? message.sources : []) as unknown as AssistantSource[];
    const cited = [...new Set(sources.filter((s) => !isWebSource(s)).map((s) => (s as { documentId: string }).documentId))];

    return this.captures.capture(
      {
        kind: 'answer',
        workspaceId: message.thread.workspaceId,
        ...(body.projectId ? { projectId: body.projectId } : {}),
        ...(body.title?.trim() ? { title: body.title } : {}),
        question: (question?.content ?? '').trim() || message.content.slice(0, 200),
        answer: stripCiteLabels(message.content),
        citedDocumentIds: cited,
        session: { client: 'assistant', sessionId: message.thread.id },
      },
      principal,
    );
  }

  /**
   * Re-drive captures a crash left staged — never claimed, or claimed by a
   * request that died — as the person who wrote them. A term waiting in the
   * inbox is staged on purpose and is left alone. A row out of attempts fails
   * here rather than being driven once more; an owner who can no longer act
   * (disabled, deleted) fails it too. Returns how many rows were settled.
   */
  async sweepStranded(): Promise<number> {
    const stale = new Date(Date.now() - this.config.get('CAPTURE_STALE_MS', { infer: true }));
    const rows = await this.prisma.knowledgeCapture.findMany({
      where: {
        status: 'staged',
        updatedAt: { lt: stale },
        AND: [
          { OR: [{ outcome: null }, { outcome: { not: 'glossary' } }] },
          { OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }] },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH,
    });

    let settled = 0;
    for (const row of rows) {
      if (row.attempts >= CAPTURE_MAX_ATTEMPTS) {
        settled += await this.fail(row, stale, row.error ?? 'out of attempts');
        continue;
      }
      let principal: Principal;
      try {
        const owner = await this.prisma.user.findUnique({ where: { id: row.createdBy }, select: { locale: true } });
        principal = await this.access.principalFor(row.createdBy, asLocale(owner?.locale));
      } catch (err) {
        settled += await this.fail(row, stale, String(err));
        continue;
      }
      try {
        const result = await this.captures.drive(row.id, principal);
        if (result.state !== 'staged') settled++;
      } catch (err) {
        // drive() released the claim (or failed the row on a refusal / the last attempt).
        this.logger.warn({ msg: 'stranded capture not proposed', captureId: row.id, error: String(err) });
      }
    }
    return settled;
  }

  /** The row, or 404 when the caller could not see it in the list. */
  private async visibleRow(id: string, principal: Principal): Promise<KnowledgeCapture> {
    const row = await this.prisma.knowledgeCapture.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.capture.notFound', { id }));
    const scope = await this.permissions.scopeFor(principal, row.workspaceId);
    const hidden =
      scope.denied.has(row.projectId) ||
      (row.targetDocumentId !== null &&
        (await this.prisma.document.count({ where: { id: row.targetDocumentId, AND: [visibilityWhere(scope)] } })) === 0);
    if (hidden) throw new NotFoundException(t('error.capture.notFound', { id }));
    return row;
  }

  private notStaged(row: KnowledgeCapture): ConflictException {
    const state = captureStateFor(row.status as CaptureStatus, null, row.glossaryTermId);
    return new ConflictException({ statusCode: 409, message: t('error.capture.notStaged', { state }), reason: 'capture-not-staged', state });
  }

  private async fail(row: KnowledgeCapture, stale: Date, error: string): Promise<number> {
    const done = await this.prisma.knowledgeCapture.updateMany({
      where: { id: row.id, status: 'staged', OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }] },
      data: { status: 'failed', claimedAt: null, error: error.slice(0, 500) },
    });
    return done.count;
  }
}

/**
 * The `[S2]` labels a reply cites its sources by mean something only inside
 * that turn; on a page they would point at nothing. The answer template lists
 * the cited pages under Sources instead.
 */
export function stripCiteLabels(text: string): string {
  return text.replace(/\s*\[S\d+\]/g, '').trim();
}
