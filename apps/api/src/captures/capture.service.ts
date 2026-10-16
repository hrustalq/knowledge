import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { KnowledgeCapture, Prisma } from '@prisma/client';
import {
  CAPTURE_SESSION_MAX_FILES,
  captureStateFor,
  entityTypeOf,
  isAuthorableRelationType,
  type AnswerCapturePayload,
  type AuthorableRelationType,
  type CaptureApiKey,
  type CaptureInfo,
  type CaptureKind,
  type CaptureOutcome,
  type CapturePageKind,
  type CaptureResult,
  type CaptureSession,
  type CaptureSettings,
  type CaptureSimilar,
  type CapturePayload,
  type CaptureStatus,
  type CreateCaptureRequest,
  type DecisionCapturePayload,
  type DocumentCategory,
  type GlossaryCapturePayload,
  type ListCapturesResponse,
  type NoteCapturePayload,
  type RelationCapturePayload,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { DocumentsService } from '../documents/documents.service.js';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { DocumentRelationsService } from '../documents/document-relations.service.js';
import { openDraftMergeRequest } from '../documents/draft-merge-request.js';
import { GraphService } from '../graph/graph.service.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { AiConfigService } from '../ai/ai-config.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { composeFrontmatter } from '../common/frontmatter.js';
import { LISTED_PAGE } from '../common/listed-page.js';
import { t } from '../i18n/t.js';
import { findSecret } from './secret-scan.js';
import {
  captureContentHash,
  cleanCaptureTitle,
  decidePage,
  dedupeText,
  foldTermKeys,
  normalizeCaptureTitle,
  rankSimilar,
  type PageDecision,
} from './capture-dedupe.js';
import {
  appendCaptureSection,
  CAPTURE_HEADING_KEYS,
  capturedEntry,
  describeSession,
  renderCaptureBody,
  withCapturedEntry,
  type CaptureBodyInput,
  type CaptureHeadings,
  type LinkedPage,
} from './capture-templates.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Pages kept on a capture for its reviewer, and returned by `knowledge_find_similar` by default. */
const SIMILAR_LIMIT = 5;
/** Chunk hits fetched per page wanted: one page owns many chunks. */
const CHUNKS_PER_PAGE = 8;
/** What is embedded for dedupe, at most. */
const DEDUPE_TEXT_CHARS = 4_000;
/** A page decision in the playbook's words, as `knowledge_find_similar` reports it. */
export type SimilarDecision = 'duplicate' | 'amend' | 'new-page';
const SIMILAR_DECISION: Record<PageDecision['outcome'], SimilarDecision> = { none: 'duplicate', 'amend-page': 'amend', 'new-page': 'new-page' };
/** Proposing attempts before a capture that keeps failing is given up. */
export const CAPTURE_MAX_ATTEMPTS = 3;

/** Where a new captured page is filed, by kind. A label, not a rule: a reviewer recategorizes freely. */
const CATEGORY_BY_KIND: Partial<Record<CaptureKind, DocumentCategory>> = {
  decision: 'architecture',
  gotcha: 'guide',
  howto: 'guide',
  convention: 'process',
  answer: 'reference',
};

/** Someone else settled the capture first (the sweeper, a concurrent call); what was being opened rolls back. */
class CaptureLost extends Error {}

/** The stored payload of each kind, read back from the row's Json. */
type StoredPayload = DecisionCapturePayload | NoteCapturePayload | GlossaryCapturePayload | RelationCapturePayload | AnswerCapturePayload;

/** What `capture()` hands the row: the resolved project, title and kind-specific body. */
interface Staged {
  kind: CaptureKind;
  projectId: string;
  title: string;
  payload: StoredPayload;
  /** Pages the capture links to, which must be readable by its writer. */
  linked: string[];
}

/**
 * Agent-session memory (issue #73): what a coding agent learned, staged as a
 * `knowledge_captures` row and proposed as a merge request a person reviews.
 *
 * ## Where it runs
 *
 * API-side, in the MCP or REST request, because a merge request is attributed
 * to a person and only the API has one ("the worker generates, the API
 * publishes"). Nothing here calls a model: the agent distilled the session,
 * and the page text is a fixed template per kind.
 *
 * ## The path
 *
 * `capture()` guards (switch, project pin, readable links, size, secrets,
 * rate limits), refuses an exact repeat, and inserts a `staged` row.
 * `drive()` claims the row, decides what it is against what exists, and
 * proposes it — page and relation outcomes as a merge request with provenance
 * `captured`, a glossary term into the inbox — settling the row in the same
 * transaction that opens the merge request. A crash between the two leaves a
 * `staged` row for the sweeper to drive again; a lost race rolls back.
 *
 * Every limit is enforced here, at the point of action, never in the skill.
 */
@Injectable()
export class CaptureService {
  private readonly logger = new Logger(CaptureService.name);
  private readonly webBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
    private readonly documents: DocumentsService,
    private readonly mergeRequests: MergeRequestsService,
    private readonly relations: DocumentRelationsService,
    private readonly graph: GraphService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    private readonly aiConfig: AiConfigService,
    private readonly activity: ActivityService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

  /** Stage one capture and propose it. The caller has passed the capture guard for the workspace or page. */
  async capture(req: CreateCaptureRequest, principal: Principal): Promise<CaptureResult> {
    const workspaceId = req.workspaceId;
    if (principal.mode !== 'dev') await this.access.requireRole(principal, workspaceId, 'editor', false, { capture: true });
    const settings = await this.aiConfig.captureSettings(workspaceId);
    if (!settings.enabled.effective) {
      throw new ForbiddenException({ statusCode: 403, message: t('error.capture.disabled'), reason: 'capture-disabled' });
    }

    const staged = await this.stage(req, principal);
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    await this.assertProjectAllowed(workspaceId, staged.projectId, principal, scope);
    await this.assertReadable(workspaceId, staged.linked, scope);

    const session = sanitizeSession(req.session);
    this.assertSize([staged.title, ...stringsOf(staged.payload)]);
    const secret = findSecret([staged.title, ...stringsOf(staged.payload), ...stringsOf(session)]);
    if (secret) {
      throw new BadRequestException({
        statusCode: 400,
        message: t('error.capture.secretDetected', { pattern: secret }),
        reason: 'capture-secret',
        pattern: secret,
      });
    }
    await this.assertWithinRate(workspaceId, principal, settings);

    const contentHash = captureContentHash(staged.kind, staged.title, staged.payload);
    const base = {
      workspaceId,
      projectId: staged.projectId,
      kind: staged.kind,
      title: staged.title,
      payload: staged.payload as unknown as Prisma.InputJsonValue,
      contentHash,
      session: session as unknown as Prisma.InputJsonValue,
      apiKeyId: principal.apiKey?.id ?? null,
      createdBy: principal.userId,
    };

    // The same capture again — a retry, a second session, a looping agent —
    // is a row of its own (it counts against the rate limit) pointing at
    // what the first became, and proposes nothing.
    const prior = await this.priorCapture(staged, contentHash);
    if (prior) {
      const row = await this.prisma.knowledgeCapture.create({
        data: {
          ...base,
          status: 'duplicate',
          outcome: 'none',
          targetDocumentId: prior.targetDocumentId,
          mergeRequestId: prior.mergeRequestId,
          glossaryTermId: prior.glossaryTermId,
        },
      });
      return this.toResult(row, await this.mergeRequestStatus(row.mergeRequestId));
    }

    const row = await this.prisma.knowledgeCapture.create({ data: { ...base, status: 'staged' } });
    return this.drive(row.id, principal);
  }

  /**
   * Claim a staged capture, decide what it is and propose it. Public for the
   * sweeper, which drives a stranded row again as its writer. A row someone
   * else holds is answered as it stands.
   */
  async drive(captureId: string, principal: Principal): Promise<CaptureResult> {
    const claimedAt = new Date();
    const stale = new Date(claimedAt.getTime() - this.config.get('CAPTURE_STALE_MS', { infer: true }));
    const claimed = await this.prisma.knowledgeCapture.updateMany({
      where: {
        id: captureId,
        status: 'staged',
        AND: [
          { OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }] },
          // A term waiting in the inbox is staged on purpose: an editor's approve settles it.
          { OR: [{ outcome: null }, { outcome: { not: 'glossary' } }] },
        ],
      },
      data: { claimedAt, attempts: { increment: 1 }, error: null },
    });
    const row = await this.prisma.knowledgeCapture.findUniqueOrThrow({ where: { id: captureId } });
    if (claimed.count !== 1) return this.toResult(row, await this.mergeRequestStatus(row.mergeRequestId));

    try {
      if (row.kind === 'relation') await this.proposeRelation(row, claimedAt, principal);
      else if (row.kind === 'glossary') await this.stageTerm(row, claimedAt);
      else await this.proposePage(row, claimedAt, principal);
    } catch (err) {
      if (!(err instanceof CaptureLost)) {
        await this.release(row, claimedAt, err);
        throw err;
      }
    }
    const settled = await this.prisma.knowledgeCapture.findUniqueOrThrow({ where: { id: captureId } });
    if (settled.status === 'proposed') {
      void this.activity.record({
        workspaceId: settled.workspaceId,
        actor: principal.userId,
        action: 'capture.proposed',
        projectId: settled.projectId,
        ...(settled.targetDocumentId ? { documentId: settled.targetDocumentId } : {}),
        subjectId: settled.id,
        metadata: { kind: settled.kind, outcome: settled.outcome, title: settled.title, mergeRequestId: settled.mergeRequestId },
      });
    }
    return this.toResult(settled, await this.mergeRequestStatus(settled.mergeRequestId));
  }

  /**
   * The pages nearest `text` by raw cosine — the vector leg alone, because a
   * search score is fused or trust-weighted and no threshold means anything
   * against it. Only pages the caller may open, in the project when given.
   */
  async similarPages(
    scope: AccessScope,
    text: string,
    opts: { projectId?: string; limit?: number } = {},
  ): Promise<CaptureSimilar[]> {
    const limit = Math.min(Math.max(opts.limit ?? SIMILAR_LIMIT, 1), 20);
    const acl = await this.permissions.documentFilterFor(scope);
    const embedding = await this.embeddings.embed(text.slice(0, DEDUPE_TEXT_CHARS));
    const hits = await this.graph.searchChunks(scope.workspaceId, embedding, limit * CHUNKS_PER_PAGE, acl);
    if (!hits.length) return [];
    const docs = await this.prisma.document.findMany({
      where: {
        id: { in: [...new Set(hits.map((h) => h.documentId))] },
        workspaceId: scope.workspaceId,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        archivedAt: null,
        ...LISTED_PAGE,
        AND: [visibilityWhere(scope)],
      },
      select: { id: true, title: true },
    });
    return rankSimilar(hits, new Map(docs.map((d) => [d.id, d.title])), limit);
  }

  /**
   * `knowledge_find_similar`. With only `text`, the pages nearest it. Given
   * the `title` and page `kind` a capture would carry, it embeds what that
   * capture embeds and says what the capture would do: `duplicate` (nothing
   * is proposed), `amend` (the top page gets a section) or `new-page` (#233).
   */
  async findSimilar(
    principal: Principal,
    scope: AccessScope,
    query: { text: string; title?: string; kind?: CapturePageKind; projectId?: string; limit?: number },
  ): Promise<{ similar: CaptureSimilar[]; decision?: SimilarDecision }> {
    const opts = { ...(query.projectId ? { projectId: query.projectId } : {}), ...(query.limit ? { limit: query.limit } : {}) };
    const title = query.title ? cleanCaptureTitle(query.title) : '';
    if (!title || !query.kind) return { similar: await this.similarPages(scope, query.text, opts) };

    const similar = await this.similarPages(scope, dedupeText(title, query.kind, query.text), opts);
    const settings = await this.aiConfig.captureSettings(scope.workspaceId);
    const decision = await this.decide(principal, scope.workspaceId, similar, title, settings);
    return { similar, decision: SIMILAR_DECISION[decision.outcome] };
  }

  /**
   * Captures in a workspace, newest first. A capture whose page the caller
   * may not open, or in a project kept from them, is left out (#76) — its
   * title would say what the page is about.
   */
  async list(
    query: {
      workspaceId: string;
      status?: CaptureStatus;
      kind?: CaptureKind;
      projectId?: string;
      createdBy?: string;
      apiKeyId?: string;
      cursor?: string;
      limit?: number;
    },
    scope: AccessScope,
  ): Promise<ListCapturesResponse> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const rows = await this.prisma.knowledgeCapture.findMany({
      where: {
        workspaceId: query.workspaceId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.createdBy ? { createdBy: query.createdBy } : {}),
        ...(query.apiKeyId ? { apiKeyId: query.apiKeyId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const targets = [...new Set(page.map((r) => r.targetDocumentId).filter((id): id is string => !!id))];
    const visible = new Set(
      targets.length
        ? (
            await this.prisma.document.findMany({
              where: { id: { in: targets }, AND: [visibilityWhere(scope)] },
              select: { id: true },
            })
          ).map((d) => d.id)
        : [],
    );
    const mrIds = page.map((r) => r.mergeRequestId).filter((id): id is string => !!id);
    const statuses = new Map(
      mrIds.length
        ? (await this.prisma.mergeRequest.findMany({ where: { id: { in: mrIds } }, select: { id: true, status: true } })).map(
            (m) => [m.id, m.status],
          )
        : [],
    );
    const shown = page.filter((r) => !scope.denied.has(r.projectId) && (!r.targetDocumentId || visible.has(r.targetDocumentId)));
    const keys = await this.apiKeys(shown.map((r) => r.apiKeyId));
    const captures = shown.map((r) =>
      this.toInfo(r, r.mergeRequestId ? (statuses.get(r.mergeRequestId) ?? null) : null, r.apiKeyId ? (keys.get(r.apiKeyId) ?? null) : null),
    );
    return { captures, nextCursor: hasMore ? page[page.length - 1]!.id : null };
  }

  /** One row as the inbox shows it, its merge request's status and its key read alongside. */
  async info(row: KnowledgeCapture): Promise<CaptureInfo> {
    const keys = await this.apiKeys([row.apiKeyId]);
    return this.toInfo(row, await this.mergeRequestStatus(row.mergeRequestId), row.apiKeyId ? (keys.get(row.apiKeyId) ?? null) : null);
  }

  /** The keys that wrote these captures, by id: name and prefix only — the hash never leaves `api_keys`. */
  async apiKeys(ids: Array<string | null>): Promise<Map<string, CaptureApiKey>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map();
    const rows = await this.prisma.apiKey.findMany({
      where: { id: { in: wanted } },
      select: { id: true, name: true, prefix: true, revokedAt: true },
    });
    return new Map(rows.map((k) => [k.id, { id: k.id, name: k.name, prefix: k.prefix, revoked: k.revokedAt !== null }]));
  }

  // ------------------------------------------------------------------ staging

  /** The project, title and stored body of a request, per kind. */
  private async stage(req: CreateCaptureRequest, principal: Principal): Promise<Staged> {
    switch (req.kind) {
      case 'decision': {
        const payload: DecisionCapturePayload = {
          context: req.context,
          decision: req.decision,
          ...(req.consequences?.trim() ? { consequences: req.consequences } : {}),
          ...(req.alternatives?.length ? { alternatives: req.alternatives } : {}),
          ...(req.relatedDocumentIds?.length ? { relatedDocumentIds: unique(req.relatedDocumentIds) } : {}),
        };
        return { kind: 'decision', projectId: req.projectId, title: cleanCaptureTitle(req.title), payload, linked: payload.relatedDocumentIds ?? [] };
      }
      case 'gotcha':
      case 'convention':
      case 'howto': {
        const payload: NoteCapturePayload = { body: req.body, ...(req.appliesTo?.length ? { appliesTo: req.appliesTo } : {}) };
        return { kind: req.kind, projectId: req.projectId, title: cleanCaptureTitle(req.title), payload, linked: [] };
      }
      case 'glossary': {
        const payload: GlossaryCapturePayload = {
          term: req.term.trim(),
          definition: req.definition,
          ...(req.aliases?.length ? { aliases: unique(req.aliases.map((a) => a.trim()).filter(Boolean)) } : {}),
          ...(req.documentId ? { documentId: req.documentId } : {}),
        };
        return { kind: 'glossary', projectId: req.projectId, title: cleanCaptureTitle(payload.term), payload, linked: req.documentId ? [req.documentId] : [] };
      }
      case 'relation': {
        if (!isAuthorableRelationType(req.type)) {
          throw new BadRequestException({ statusCode: 400, message: t('error.capture.relationType', { type: req.type }), reason: 'capture-relation-type' });
        }
        const doc = await this.prisma.document.findUnique({
          where: { id: req.documentId },
          select: { workspaceId: true, projectId: true },
        });
        if (!doc || doc.workspaceId !== req.workspaceId) throw new NotFoundException(t('error.document.notFound', { id: req.documentId }));
        // The page itself, at editor: a relation edits it (the MCP guard checked it too).
        if (principal.mode !== 'dev') {
          await this.permissions.requireResource(principal, req.workspaceId, { type: 'document', id: req.documentId }, 'editor', false, {
            capture: true,
          });
        }
        const payload: RelationCapturePayload = {
          documentId: req.documentId,
          type: req.type,
          targetKey: req.targetKey.trim(),
          rationale: req.rationale,
        };
        return { kind: 'relation', projectId: doc.projectId, title: cleanCaptureTitle(`${payload.type} ${payload.targetKey}`), payload, linked: [] };
      }
      case 'answer': {
        const cited = unique(req.citedDocumentIds ?? []);
        if (!cited.length) {
          throw new BadRequestException({ statusCode: 400, message: t('error.capture.noCitations'), reason: 'capture-no-citations' });
        }
        let projectId = req.projectId;
        if (!projectId) {
          const first = await this.prisma.document.findFirst({
            where: { id: cited[0], workspaceId: req.workspaceId },
            select: { projectId: true },
          });
          if (!first) throw new NotFoundException(t('error.capture.unreadablePages', { ids: cited[0] }));
          projectId = first.projectId;
        }
        const payload: AnswerCapturePayload = { question: req.question, answer: req.answer, citedDocumentIds: cited };
        const title = cleanCaptureTitle(req.title?.trim() || firstLine(req.question));
        return { kind: 'answer', projectId, title, payload, linked: cited };
      }
    }
  }

  /** The project is in the workspace, the key's pin covers it, and its writer may see it. */
  private async assertProjectAllowed(workspaceId: string, projectId: string, principal: Principal, scope: AccessScope): Promise<void> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } });
    if (!project) throw new NotFoundException(t('error.capture.projectNotFound', { projectId }));
    const pin = principal.apiKey?.projectIds;
    if ((pin && !pin.includes(projectId)) || scope.denied.has(projectId)) {
      throw new ForbiddenException({
        statusCode: 403,
        message: t('error.capture.projectNotAllowed', { projectId }),
        reason: 'capture-project-not-allowed',
      });
    }
  }

  /** Every page a capture links to exists in the workspace and is one its writer can open. Ids only in the refusal, never titles. */
  private async assertReadable(workspaceId: string, ids: string[], scope: AccessScope): Promise<void> {
    if (!ids.length) return;
    const found = await this.prisma.document.findMany({
      where: { id: { in: ids }, workspaceId, AND: [visibilityWhere(scope)] },
      select: { id: true },
    });
    const ok = new Set(found.map((d) => d.id));
    const missing = ids.filter((id) => !ok.has(id));
    if (missing.length) {
      throw new NotFoundException({
        statusCode: 404,
        message: t('error.capture.unreadablePages', { ids: missing.join(', ') }),
        reason: 'capture-unreadable-pages',
        documentIds: missing,
      });
    }
  }

  private assertSize(texts: string[]): void {
    const limit = this.config.get('CAPTURE_MAX_CHARS', { infer: true });
    const size = texts.reduce((n, s) => n + s.length, 0);
    if (size > limit) {
      throw new BadRequestException({
        statusCode: 400,
        message: t('error.capture.tooLong', { size, limit }),
        reason: 'capture-too-long',
        limit,
      });
    }
  }

  /**
   * Rows already written in the rolling window, per key and per workspace —
   * a count over the captures themselves, so there is no counter to drift.
   * `retryAfterSec` is when the oldest row in the window leaves it.
   */
  private async assertWithinRate(workspaceId: string, principal: Principal, settings: CaptureSettings): Promise<void> {
    const now = Date.now();
    const check = async (where: Prisma.KnowledgeCaptureWhereInput, windowMs: number, limit: number, per: 'key' | 'workspace') => {
      const since = new Date(now - windowMs);
      const inWindow = { ...where, createdAt: { gt: since } };
      const used = await this.prisma.knowledgeCapture.count({ where: inWindow });
      if (used < limit) return;
      const oldest = await this.prisma.knowledgeCapture.findFirst({ where: inWindow, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
      const retryAfterSec = Math.max(1, Math.ceil(((oldest?.createdAt.getTime() ?? now) + windowMs - now) / 1000));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: t(per === 'key' ? 'error.capture.rateLimited' : 'error.capture.workspaceRateLimited', { limit, retryAfterSec }),
          reason: 'capture-rate-limited',
          per,
          limit,
          retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    };
    if (principal.apiKey) await check({ apiKeyId: principal.apiKey.id }, HOUR_MS, settings.perKeyPerHour.effective, 'key');
    await check({ workspaceId }, DAY_MS, settings.perWorkspacePerDay.effective, 'workspace');
  }

  /**
   * What an earlier capture already covers: the same content (any outcome but
   * a failure, which may be retried), or — for a capture still in flight,
   * whose page is not searchable yet — the same kind under the same title.
   */
  private async priorCapture(staged: Staged, contentHash: string): Promise<KnowledgeCapture | null> {
    const same = await this.prisma.knowledgeCapture.findFirst({
      where: { projectId: staged.projectId, contentHash, status: { not: 'failed' } },
      orderBy: { createdAt: 'asc' },
    });
    if (same) return same;
    if (staged.kind === 'relation') return null;
    const inFlight = await this.prisma.knowledgeCapture.findMany({
      where: {
        projectId: staged.projectId,
        kind: staged.kind,
        status: { in: ['staged', 'proposed'] },
        title: { equals: staged.title, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });
    const statuses = await this.mergeRequestStatuses(inFlight.map((r) => r.mergeRequestId));
    const title = normalizeCaptureTitle(staged.title);
    return (
      inFlight.find(
        (r) =>
          normalizeCaptureTitle(r.title) === title &&
          (r.status === 'staged' || statuses.get(r.mergeRequestId ?? '') === 'open'),
      ) ?? null
    );
  }

  // ------------------------------------------------------------------ proposing

  private async proposePage(row: KnowledgeCapture, claimedAt: Date, principal: Principal): Promise<void> {
    const settings = await this.aiConfig.captureSettings(row.workspaceId);
    const scope = await this.permissions.scopeFor(principal, row.workspaceId);
    const payload = row.payload as unknown as StoredPayload;
    const kind = row.kind as CaptureKind;
    const similar = await this.similarPages(scope, dedupeText(row.title, kind, mainText(kind, payload)), { projectId: row.projectId });

    const decision = await this.decide(principal, row.workspaceId, similar, row.title, settings);
    if (decision.outcome === 'none') {
      return this.settle(row.id, claimedAt, {
        status: 'duplicate',
        outcome: 'none',
        targetDocumentId: decision.targetDocumentId,
        similar: similar as unknown as Prisma.InputJsonValue,
      });
    }
    const lang = principal.locale;
    const h = this.headings(lang, row.title);
    const input = await this.bodyInput(kind, payload);
    const session = row.session as unknown as CaptureSession;
    const entry = capturedEntry(row.id, kind, session, row.createdAt);
    const title = t('capture.mergeRequest.title', { kind: t(`capture.kind.${kind}`, undefined, lang), title: row.title }, lang).slice(0, 200);
    const branch = `capture/${row.id.slice(0, 8)}-${claimedAt.getTime()}`;
    const deps = { prisma: this.prisma, storage: this.storage, documents: this.documents, mergeRequests: this.mergeRequests };
    const tx = { timeout: 30_000, maxWait: 10_000 };

    if (decision.outcome === 'amend-page') {
      const target = decision.targetDocumentId;
      const content = await this.documents.getContent(target);
      const top = similar.find((s) => s.documentId === target);
      const description = this.describe(session, similar, lang, t('capture.mergeRequest.amends', { page: top?.title ?? '', score: top?.score ?? '' }, lang));
      await openDraftMergeRequest(deps, {
        documentId: target,
        branch,
        title,
        description,
        markdown: composeFrontmatter(
          appendCaptureSection(content.markdown, renderCaptureBody(input, h, 3), h),
          withCapturedEntry(content.frontmatter ?? {}, entry),
        ),
        userId: principal.userId,
        provenance: 'captured',
        captureId: row.id,
        onCreated: (id) =>
          this.settle(row.id, claimedAt, {
            status: 'proposed',
            outcome: 'amend-page',
            mergeRequestId: id,
            targetDocumentId: target,
            similar: similar as unknown as Prisma.InputJsonValue,
          }),
      });
      return;
    }

    // Option A (#73, phase 0): the page is created head-less, its content on a
    // branch behind the merge request, and hidden from every list until a
    // person merges it.
    const parentId = await this.parentFor(settings.parentDocumentId, row.projectId);
    const category = CATEGORY_BY_KIND[kind];
    const description = this.describe(session, similar, lang, t('capture.mergeRequest.newPage', undefined, lang));
    await this.prisma.withTransaction(async () => {
      const created = await this.documents.createDocument(
        {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          title: row.title,
          ...(parentId ? { parentId } : {}),
          ...(category ? { category } : {}),
        },
        principal.userId,
      );
      await openDraftMergeRequest(deps, {
        documentId: created.documentId,
        branch,
        title,
        description,
        markdown: composeFrontmatter(renderCaptureBody(input, h, 2), { source: `capture:${session.client}`, captured: [entry] }),
        userId: principal.userId,
        provenance: 'captured',
        captureId: row.id,
        newPage: true,
        onCreated: (id) =>
          this.settle(row.id, claimedAt, {
            status: 'proposed',
            outcome: 'new-page',
            mergeRequestId: id,
            targetDocumentId: created.documentId,
            similar: similar as unknown as Prisma.InputJsonValue,
          }),
      });
    }, tx);
  }

  /** A frontmatter relation, through the same merge request path a person's relation edit takes. */
  private async proposeRelation(row: KnowledgeCapture, claimedAt: Date, principal: Principal): Promise<void> {
    const payload = row.payload as unknown as RelationCapturePayload;
    const session = row.session as unknown as CaptureSession;
    const lang = principal.locale;
    const result = await this.relations.propose(
      payload.documentId,
      {
        add: [{ type: payload.type as AuthorableRelationType, target: { type: entityTypeOf(payload.targetKey), key: payload.targetKey } }],
        title: t('capture.mergeRequest.title', { kind: t('capture.kind.relation', undefined, lang), title: row.title }, lang).slice(0, 200),
        description: `${this.describe(session, [], lang)}\n\n${t('capture.mergeRequest.rationale', undefined, lang)} ${payload.rationale}`.slice(0, 2_000),
      },
      principal,
      {
        provenance: 'captured',
        captureId: row.id,
        onCreated: (id) =>
          this.settle(row.id, claimedAt, { status: 'proposed', outcome: 'relation', mergeRequestId: id, targetDocumentId: payload.documentId }),
      },
    );
    // The page already declares it: nothing was opened.
    if (!result.changed) {
      await this.settle(row.id, claimedAt, { status: 'duplicate', outcome: 'none', targetDocumentId: payload.documentId });
    }
  }

  /**
   * A term is a row, not a revision, so there is no merge request to open: it
   * waits in the captures inbox, `staged` with outcome `glossary`, until an
   * editor approves it (`CaptureInboxService.approve`). A term or alias the project already has, or
   * one already waiting, is a duplicate.
   */
  private async stageTerm(row: KnowledgeCapture, claimedAt: Date): Promise<void> {
    const payload = row.payload as unknown as GlossaryCapturePayload;
    const keys = foldTermKeys(payload.term, payload.aliases);
    const overlaps = (term: string, aliases: unknown) =>
      [...foldTermKeys(term, Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === 'string') : [])].some((k) => keys.has(k));

    const terms = await this.prisma.glossaryTerm.findMany({
      where: { projectId: row.projectId },
      select: { id: true, term: true, aliases: true },
    });
    const existing = terms.find((term) => overlaps(term.term, term.aliases));
    if (existing) {
      return this.settle(row.id, claimedAt, { status: 'duplicate', outcome: 'none', glossaryTermId: existing.id });
    }
    const waiting = await this.prisma.knowledgeCapture.findMany({
      where: { projectId: row.projectId, kind: 'glossary', status: 'staged', outcome: 'glossary', id: { not: row.id } },
      select: { payload: true },
    });
    const queued = waiting.some((w) => {
      const p = w.payload as unknown as GlossaryCapturePayload;
      return overlaps(p.term, p.aliases);
    });
    await this.settle(row.id, claimedAt, queued ? { status: 'duplicate', outcome: 'none' } : { outcome: 'glossary', claimedAt: null });
  }

  /**
   * staged → wherever it went, only from the claim this call holds. Inside the
   * transaction that opened a merge request, a miss rolls the merge request back.
   */
  private async settle(id: string, claimedAt: Date, data: Prisma.KnowledgeCaptureUpdateManyMutationInput): Promise<void> {
    const done = await this.prisma.knowledgeCapture.updateMany({
      where: { id, status: 'staged', claimedAt },
      data: { claimedAt: null, ...data },
    });
    if (done.count !== 1) throw new CaptureLost();
  }

  /**
   * Hand the claim back after a failure. A refusal (a 4xx) will refuse again,
   * and so will a capture out of attempts: those fail. Anything else is left
   * staged and unclaimed for the sweeper.
   */
  private async release(row: KnowledgeCapture, claimedAt: Date, err: unknown): Promise<void> {
    const refused = err instanceof HttpException && err.getStatus() < 500;
    const giveUp = refused || row.attempts + 1 >= CAPTURE_MAX_ATTEMPTS;
    this.logger.warn({ msg: 'capture not proposed', captureId: row.id, giveUp, error: String(err) });
    await this.prisma.knowledgeCapture.updateMany({
      where: { id: row.id, status: 'staged', claimedAt },
      data: { claimedAt: null, error: String(err).slice(0, 500), ...(giveUp ? { status: 'failed' } : {}) },
    });
  }

  // ------------------------------------------------------------------ helpers

  /**
   * What the nearest pages make of a page-kind capture titled `title`, under
   * the workspace's thresholds. `proposePage` acts on it; `findSimilar` only
   * reports it, so the probe and the capture cannot disagree (#233).
   */
  private async decide(
    principal: Principal,
    workspaceId: string,
    similar: readonly CaptureSimilar[],
    title: string,
    settings: CaptureSettings,
  ): Promise<PageDecision> {
    const decision = decidePage(similar, title, {
      dedupe: settings.dedupeThreshold.effective,
      amend: settings.amendThreshold.effective,
    });
    // A page close enough to amend but one its writer may only read gets a
    // page of its own instead: a capture never proposes what its person could not.
    if (decision.outcome === 'amend-page' && !(await this.canEdit(principal, workspaceId, decision.targetDocumentId))) {
      return { outcome: 'new-page', targetDocumentId: null };
    }
    return decision;
  }

  private async canEdit(principal: Principal, workspaceId: string, documentId: string): Promise<boolean> {
    if (principal.mode === 'dev') return true;
    try {
      await this.permissions.requireResource(principal, workspaceId, { type: 'document', id: documentId }, 'editor', false, { capture: true });
      return true;
    } catch {
      return false;
    }
  }

  /** The workspace's parent page for new captures, when it is a live page of this project. */
  private async parentFor(parentId: string | null, projectId: string): Promise<string | null> {
    if (!parentId) return null;
    const parent = await this.prisma.document.findFirst({
      where: { id: parentId, projectId, archivedAt: null },
      select: { id: true },
    });
    return parent?.id ?? null;
  }

  private async bodyInput(kind: CaptureKind, payload: StoredPayload): Promise<CaptureBodyInput> {
    switch (kind) {
      case 'decision': {
        const p = payload as DecisionCapturePayload;
        return { kind, payload: p, related: await this.linkedPages(p.relatedDocumentIds ?? []) };
      }
      case 'answer': {
        const p = payload as AnswerCapturePayload;
        return { kind, payload: p, cited: await this.linkedPages(p.citedDocumentIds) };
      }
      case 'gotcha':
      case 'convention':
      case 'howto':
        return { kind, payload: payload as NoteCapturePayload };
      default:
        throw new Error(`capture kind ${kind} is not a page`);
    }
  }

  /** Titles for linked pages, in the order given; a page deleted since staging drops out. */
  private async linkedPages(ids: string[]): Promise<LinkedPage[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.document.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
    const byId = new Map(rows.map((r) => [r.id, r.title]));
    return ids.filter((id) => byId.has(id)).map((id) => ({ documentId: id, title: byId.get(id)! }));
  }

  private headings(lang: Principal['locale'], title: string): CaptureHeadings {
    const h = Object.fromEntries(CAPTURE_HEADING_KEYS.map((k) => [k, t(`capture.heading.${k}`, undefined, lang)]));
    return { ...h, captured: t('capture.heading.captured', { title }, lang) } as CaptureHeadings;
  }

  /** The merge request description: where it came from, what it does, what it was compared with. */
  private describe(session: CaptureSession, similar: readonly CaptureSimilar[], lang: Principal['locale'], what?: string): string {
    const lines = [
      session.client === 'assistant'
        ? t('capture.mergeRequest.introAssistant', undefined, lang)
        : t('capture.mergeRequest.intro', { source: describeSession(session) }, lang),
    ];
    if (what) lines.push('', what);
    if (similar.length) {
      lines.push('', t('capture.mergeRequest.similar', undefined, lang));
      for (const s of similar) lines.push(`- [${s.title}](/documents/${s.documentId}) — ${s.score}`);
    }
    return lines.join('\n').slice(0, 4_000);
  }

  private async mergeRequestStatus(id: string | null): Promise<string | null> {
    if (!id) return null;
    return (await this.mergeRequestStatuses([id])).get(id) ?? null;
  }

  private async mergeRequestStatuses(ids: Array<string | null>): Promise<Map<string, string>> {
    const wanted = ids.filter((id): id is string => !!id);
    if (!wanted.length) return new Map();
    const rows = await this.prisma.mergeRequest.findMany({ where: { id: { in: wanted } }, select: { id: true, status: true } });
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  private toResult(row: KnowledgeCapture, mergeRequestStatus: string | null): CaptureResult {
    const webUrl = row.mergeRequestId
      ? `${this.webBaseUrl}/merge-requests/${row.mergeRequestId}`
      : row.targetDocumentId
        ? `${this.webBaseUrl}/documents/${row.targetDocumentId}`
        : null;
    return {
      captureId: row.id,
      state: captureStateFor(row.status as CaptureStatus, mergeRequestStatus, row.glossaryTermId),
      outcome: (row.outcome as CaptureOutcome | null) ?? null,
      mergeRequestId: row.mergeRequestId,
      targetDocumentId: row.targetDocumentId,
      glossaryTermId: row.glossaryTermId,
      webUrl,
      similar: Array.isArray(row.similar) ? (row.similar as unknown as CaptureSimilar[]) : [],
    };
  }

  private toInfo(row: KnowledgeCapture, mergeRequestStatus: string | null, apiKey: CaptureApiKey | null): CaptureInfo {
    return {
      ...this.toResult(row, mergeRequestStatus),
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      kind: row.kind as CaptureKind,
      title: row.title,
      payload: row.payload as unknown as CapturePayload,
      session: row.session as unknown as CaptureSession,
      createdBy: row.createdBy,
      apiKeyId: row.apiKeyId,
      apiKey,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** Paths only, at most CAPTURE_SESSION_MAX_FILES, and no field longer than a path needs to be. */
function sanitizeSession(session: CaptureSession): CaptureSession {
  const clip = (s: string | undefined) => (s?.trim() ? s.trim().slice(0, 500) : undefined);
  const out: CaptureSession = { client: session.client };
  for (const key of ['clientVersion', 'sessionId', 'repo', 'branch', 'commit', 'startedAt'] as const) {
    const v = clip(session[key]);
    if (v) out[key] = v;
  }
  const files = (session.files ?? []).map(clip).filter((f): f is string => !!f).slice(0, CAPTURE_SESSION_MAX_FILES);
  if (files.length) out.files = files;
  return out;
}

/** Every string inside a payload or session, for the size cap and the secret scan. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsOf);
  return [];
}

/** A page-kind capture's main text, as `dedupeText` takes it — what `knowledge_find_similar` asks an agent to pass as `text`. */
function mainText(kind: CaptureKind, payload: StoredPayload): string {
  if (kind === 'decision') return `${(payload as DecisionCapturePayload).context}\n${(payload as DecisionCapturePayload).decision}`;
  if (kind === 'answer') return `${(payload as AnswerCapturePayload).question}\n${(payload as AnswerCapturePayload).answer}`;
  return (payload as NoteCapturePayload).body;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
