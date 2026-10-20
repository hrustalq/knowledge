import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AnalyticsChannel } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Who is asking, as far as analytics cares (#79). Carried by every recorded
 * read and search. `channel` is set by a caller that is not a person at a
 * browser or a key over REST — MCP, the assistant, a chat bot, an agent run —
 * and resolved from the principal otherwise.
 */
export interface AnalyticsCaller {
  principal: Principal;
  channel?: AnalyticsChannel;
  /** The request sent `DNT: 1` or `Sec-GPC: 1`: counted, never tied to a reader. */
  noTrack?: boolean;
}

export interface RecordedSearch {
  workspaceId: string;
  query: string;
  mode: string;
  projectIds: string[];
  /** Result document ids in rank order; the first 10 are kept. */
  resultDocIds: string[];
  durationMs: number;
}

export interface RecordedToolCall {
  tool: string;
  workspaceId: string | null;
  /** Resolves the workspace of a tool that names a page instead. */
  documentId?: string | null;
  ok: boolean;
  errorCode: string | null;
  durationMs: number;
}

export interface RecordedWebView {
  viewId: string;
  revisionId?: string | null;
  /** The search result this view was opened from, and its 1-based rank. */
  searchId?: string | null;
  searchRank?: number | null;
}

/** A request's privacy signals, for the callers that have one. */
export function noTrackOf(headers: Record<string, string | string[] | undefined>): boolean {
  return headers['dnt'] === '1' || headers['sec-gpc'] === '1';
}

/**
 * The channel a read or search is filed under. An explicit surface wins; then
 * a run owner rehydrated for background work (`api-key` mode with no key —
 * `AccessService.principalFor`) is an agent, never a person's key; then a key
 * is `api`, and a session or the dev principal is `web`.
 */
export function channelFor(caller: AnalyticsCaller): AnalyticsChannel {
  if (caller.channel) return caller.channel;
  const { principal } = caller;
  if (principal.apiKey) return 'api';
  if (principal.mode === 'api-key') return 'agent';
  return 'web';
}

/** Trimmed, NFC, inner whitespace collapsed, at most 500 characters. */
export function foldQuery(query: string): string {
  return query.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** The grouping key of a query: survives the text being redacted by retention. */
export function queryHashOf(folded: string): string {
  return createHash('sha256').update(folded.toLowerCase()).digest('hex');
}

const SETTINGS_TTL_MS = 60_000;

/**
 * Writes the analytics event rows (#79): one per search, MCP tool call and
 * non-web page read. Fire-and-forget like `ActivityService.record` — every
 * method swallows its own failure, so a broken analytics write never fails the
 * search, read or tool call it describes.
 *
 * Web page views are not recorded by `view()`: they come from the page's own
 * beacon (`webView`, `heartbeat`), because `GET /:id/content` is also hit by
 * SSR and prefetch, and counting those would count a page nobody looked at.
 */
@Injectable()
export class AnalyticsRecorder {
  private readonly logger = new Logger(AnalyticsRecorder.name);
  private readonly secret: Buffer;
  private readonly enabledCache = new Map<string, { enabled: boolean; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    const own = config.get('ANALYTICS_READER_SECRET', { infer: true });
    const settings = config.get('SETTINGS_ENCRYPTION_KEY', { infer: true });
    if (own) this.secret = Buffer.from(own);
    else if (settings) this.secret = createHash('sha256').update(`analytics-reader:${settings}`).digest();
    else {
      this.secret = randomBytes(32);
      if (config.get('ANALYTICS_ENABLED', { infer: true })) {
        this.logger.warn(
          'ANALYTICS_READER_SECRET and SETTINGS_ENCRYPTION_KEY are both empty: unique readers are counted per process',
        );
      }
    }
  }

  /**
   * Who read, without naming them: an HMAC of the person within one
   * workspace, so the same person in two workspaces is two unrelated keys.
   * Null under DNT / GPC — the event still counts, the reader does not.
   */
  readerKey(caller: AnalyticsCaller, workspaceId: string | null): string | null {
    if (caller.noTrack || !workspaceId) return null;
    return createHmac('sha256', this.secret).update(`${workspaceId}:${caller.principal.userId}`).digest('hex').slice(0, 32);
  }

  /**
   * Recording is on for a workspace: the env ceiling, then its sparse
   * setting. Cached for a minute — a setting change reaches the recorder
   * within one, and a search does not pay a settings read.
   */
  async enabled(workspaceId: string): Promise<boolean> {
    if (!this.config.get('ANALYTICS_ENABLED', { infer: true })) return false;
    const hit = this.enabledCache.get(workspaceId);
    if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.enabled;
    const row = await this.prisma.workspaceSettings.findUnique({
      where: { workspaceId },
      select: { analyticsEnabled: true },
    });
    const enabled = row?.analyticsEnabled ?? true;
    this.enabledCache.set(workspaceId, { enabled, at: Date.now() });
    return enabled;
  }

  /** Drop the cached setting, after this process changed it. */
  forget(workspaceId: string): void {
    this.enabledCache.delete(workspaceId);
  }

  /**
   * Record one search and return its id, or null when nothing was recorded.
   * The id is minted before the write so the response need not wait for it.
   */
  search(caller: AnalyticsCaller, s: RecordedSearch): string | null {
    if (!this.config.get('ANALYTICS_ENABLED', { infer: true })) return null;
    const id = randomUUID();
    void this.guard('search', async () => {
      if (!(await this.enabled(s.workspaceId))) return;
      const text = foldQuery(s.query);
      await this.prisma.searchQuery.create({
        data: {
          id,
          workspaceId: s.workspaceId,
          projectIds: s.projectIds,
          queryText: text,
          queryHash: queryHashOf(text),
          mode: s.mode,
          resultCount: s.resultDocIds.length,
          resultDocIds: s.resultDocIds.slice(0, 10),
          channel: channelFor(caller),
          readerKey: this.readerKey(caller, s.workspaceId),
          apiKeyId: caller.principal.apiKey?.id ?? null,
          durationMs: Math.round(s.durationMs),
        },
      });
    });
    return id;
  }

  /**
   * Record a server-side page read — a key, MCP, the assistant, an agent.
   * A `web` read is dropped (see the class comment). The page's workspace and
   * project are resolved here, once, so no call site has to know them.
   */
  view(caller: AnalyticsCaller, documentId: string, revisionId?: string | null): Promise<void> {
    const channel = channelFor(caller);
    if (channel === 'web' || !this.config.get('ANALYTICS_ENABLED', { infer: true })) return Promise.resolve();
    return this.guard('view', async () => {
      const doc = await this.prisma.document.findUnique({
        where: { id: documentId },
        select: { workspaceId: true, projectId: true },
      });
      if (!doc || !(await this.enabled(doc.workspaceId))) return;
      await this.prisma.pageView.create({
        data: {
          id: randomUUID(),
          workspaceId: doc.workspaceId,
          projectId: doc.projectId,
          documentId,
          revisionId: revisionId ?? null,
          channel,
          readerKey: this.readerKey(caller, doc.workspaceId),
          apiKeyId: caller.principal.apiKey?.id ?? null,
        },
      });
    });
  }

  /**
   * Open a web view from the page's beacon. `viewId` is the page's own, so a
   * replayed beacon is a no-op. The route has already checked the caller may
   * open the page.
   */
  webView(caller: AnalyticsCaller, documentId: string, v: RecordedWebView): Promise<void> {
    if (!this.config.get('ANALYTICS_ENABLED', { infer: true })) return Promise.resolve();
    return this.guard('web view', async () => {
      const doc = await this.prisma.document.findUnique({
        where: { id: documentId },
        select: { workspaceId: true, projectId: true },
      });
      if (!doc || !(await this.enabled(doc.workspaceId))) return;
      await this.prisma.pageView.createMany({
        data: [
          {
            id: v.viewId,
            workspaceId: doc.workspaceId,
            projectId: doc.projectId,
            documentId,
            revisionId: v.revisionId ?? null,
            channel: channelFor(caller),
            readerKey: this.readerKey(caller, doc.workspaceId),
            apiKeyId: caller.principal.apiKey?.id ?? null,
            searchId: v.searchId ?? null,
            searchRank: v.searchRank ?? null,
          },
        ],
        skipDuplicates: true,
      });
    });
  }

  /**
   * Fold a view's active read time into its row: one guarded statement, so
   * time only grows, never past the cap, and only on a row this reader opened
   * — a heartbeat naming someone else's view changes nothing.
   */
  heartbeat(caller: AnalyticsCaller, viewId: string, activeMs: number): Promise<void> {
    if (!this.config.get('ANALYTICS_ENABLED', { infer: true })) return Promise.resolve();
    return this.guard('heartbeat', async () => {
      // The reader key is per workspace, so the row's workspace is read first.
      const row = await this.prisma.pageView.findUnique({ where: { id: viewId }, select: { workspaceId: true } });
      if (!row) return;
      const cap = this.config.get('ANALYTICS_READ_TIME_CAP_MS', { infer: true });
      const reader = this.readerKey(caller, row.workspaceId);
      await this.prisma.$executeRaw`
        UPDATE page_views
        SET active_ms = LEAST(GREATEST(active_ms, ${Math.round(activeMs)}), ${cap}), last_seen_at = now()
        WHERE id = ${viewId}::uuid AND channel = 'web' AND reader_key IS NOT DISTINCT FROM ${reader}::text`;
    });
  }

  /** Record one MCP tool call. */
  toolCall(caller: AnalyticsCaller, c: RecordedToolCall): Promise<void> {
    if (!this.config.get('ANALYTICS_ENABLED', { infer: true })) return Promise.resolve();
    return this.guard('tool call', async () => {
      const workspaceId =
        c.workspaceId ??
        (c.documentId
          ? ((await this.prisma.document.findUnique({ where: { id: c.documentId }, select: { workspaceId: true } }))
              ?.workspaceId ?? null)
          : null);
      if (workspaceId && !(await this.enabled(workspaceId))) return;
      await this.prisma.mcpToolCall.create({
        data: {
          workspaceId,
          tool: c.tool,
          ok: c.ok,
          errorCode: c.errorCode,
          readerKey: this.readerKey(caller, workspaceId),
          apiKeyId: caller.principal.apiKey?.id ?? null,
          durationMs: Math.round(c.durationMs),
        },
      });
    });
  }

  private async guard(what: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (e) {
      this.logger.warn(`Analytics ${what} record failed (non-fatal): ${(e as Error).message}`);
    }
  }
}
