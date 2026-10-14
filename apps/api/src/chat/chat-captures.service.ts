import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ChatCapture, type ChatIntegration } from '@prisma/client';
import { isLocale, isWebSource, type AssistantSource, type ChatCaptureKind, type Locale } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { CITE_MARKER_RE } from '../assistant/citations.js';
import { composeFrontmatter } from '../common/frontmatter.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { DocumentsService } from '../documents/documents.service.js';
import { openDraftMergeRequest } from '../documents/draft-merge-request.js';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { GlossaryService } from '../glossary/glossary.service.js';
import { StorageService } from '../storage/storage.service.js';
import { t, withLocale } from '../i18n/t.js';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry.js';
import type { ChatAdapter, ChatAdapterContext, ChatLinkButton, ChatMessageRef } from './adapters/chat-adapter.types.js';
import { ChatIntegrationsService } from './chat-integrations.service.js';

/** The newest turns of a conversation that are saved; older ones are rarely what a page is about. */
const MAX_TURNS = 20;
/** What the drafter is handed, at most. */
const MAX_TRANSCRIPT_CHARS = 24_000;
const REAP_BATCH = 50;

/**
 * Appended to the drafter's own instructions. The title travels as the first
 * line rather than in JSON because the drafter answers in markdown only — the
 * same contract it has everywhere else.
 */
const PAGE_FROM_CHAT =
  'Turn the conversation below into a documentation page for the next person with the same questions. ' +
  'Start with a single line `# <page title>`, then the page. Write it as documentation, not as a ' +
  'conversation: no questions and answers, no mention of the chat or of an assistant. Keep only what ' +
  'the answers establish, and keep their page links. Write in the language of the conversation.';

/** A refusal with something to tell the person, as a message key. */
class CaptureRefused extends Error {
  constructor(readonly key: string) {
    super(key);
  }
}

/** The sweeper settled the capture first; whatever was being published is rolled back. */
class CaptureLost extends Error {}

export interface CaptureRequest {
  integration: ChatIntegration;
  adapter: ChatAdapter;
  ctx: ChatAdapterContext;
  /** The answer Save was pressed under; the "Drafting…" message replies to it. */
  answerMessage: ChatMessageRef;
  answer: { id: string; conversationId: string; createdAt: Date };
  /** The group's project, or null (a DM) for the workspace's first. */
  projectId: string | null;
  principal: Principal;
  kind: ChatCaptureKind;
  locale: Locale;
  workspaceName: string;
}

/** One stored assistant-thread message, as much of it as a transcript reads. */
export interface TranscriptMessage {
  id: string;
  role: string;
  content: string;
  sources: unknown;
}

/**
 * The turns of a chat conversation that were shown in the chat, as a
 * transcript: each shown answer with the question before it. Citation markers
 * become links to the pages they cite, so a page drafted from it links them
 * the way the drafter keeps links.
 *
 * `shown` is the answers the bot actually posted. A thread can carry more —
 * its owner may have carried on in /assistant — and those turns were never in
 * the chat, so they are never saved from it.
 */
export function chatTranscript(messages: readonly TranscriptMessage[], shown: ReadonlySet<string>): string {
  const turns: string[] = [];
  let question: string | null = null;
  for (const m of messages) {
    if (m.role === 'user') question = m.content;
    if (m.role !== 'assistant' || !shown.has(m.id)) continue;
    const sources = (Array.isArray(m.sources) ? m.sources : []) as AssistantSource[];
    const href = (s: AssistantSource) => (isWebSource(s) ? s.url : `/documents/${s.documentId}`);
    const byLabel = new Map(sources.filter((s) => s.cite).map((s) => [s.cite!.toUpperCase(), s]));
    // The space before a marker goes with it: the link brings its own.
    const answer = m.content.replace(new RegExp(`\\s*${CITE_MARKER_RE.source}`, 'gi'), (_, labels: string) =>
      labels
        .split(/\s*[,;]\s*/)
        .map((label) => byLabel.get(label.toUpperCase()))
        .filter((s): s is AssistantSource => !!s)
        .map((s) => ` ([${s.title}](${href(s)}))`)
        .join(''),
    );
    turns.push(`Question: ${(question ?? '').trim()}\n\nAnswer:\n${answer.trim()}`);
    question = null;
  }
  return turns.join('\n\n---\n\n');
}

/** `# Title` on the first line, the page after it; a page with no heading takes the fallback. */
export function splitDraft(raw: string, fallback: string): { title: string; body: string } {
  const text = raw.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, '$1').trim();
  const m = /^#\s+(.+)\n?/.exec(text);
  const title = (m?.[1].trim() || fallback).slice(0, 300);
  return { title, body: (m ? text.slice(m[0].length) : text).trim() };
}

/**
 * Saving a chat conversation (issue #71, phase 2): as a page draft behind a
 * merge request, or as a glossary term proposed switched off.
 *
 * ## Where it runs
 *
 * In the API, on the continuation the button press already runs on — the
 * shape answers use, for the same reason: publishing needs the API-only merge
 * request service, and the draft is one completion. The `pending` row is the
 * claim, so a double press saves once; the chat sweeper fails what a restart
 * strands ({@link reapStale}).
 *
 * ## As whom
 *
 * The person who pressed Save, who must be linked and an **editor** — checked
 * at the press and again just before anything is written, because the draft
 * takes a while and a role can change in it. Nothing goes live: a page is
 * created empty and its body arrives on a branch with a merge request, and a
 * term is created switched off until an editor turns it on.
 *
 * Page create, merge request and the claim's `published` commit together. If
 * the sweeper already failed the capture, the guarded update inside the
 * transaction finds nothing and the page goes with it.
 */
@Injectable()
export class ChatCapturesService {
  private readonly logger = new Logger(ChatCapturesService.name);
  private readonly webBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly documents: DocumentsService,
    private readonly mergeRequests: MergeRequestsService,
    private readonly storage: StorageService,
    private readonly glossary: GlossaryService,
    private readonly agents: AgentRegistryService,
    private readonly client: AssistantClient,
    private readonly aiUsage: AiUsageService,
    private readonly registry: ChatAdapterRegistry,
    private readonly integrations: ChatIntegrationsService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    this.timeoutMs = config.get('CHAT_CAPTURE_TIMEOUT_SECONDS', { infer: true }) * 1000;
  }

  /** One press of "Save as …". Never throws: it runs after the webhook has answered. */
  async start(req: CaptureRequest): Promise<void> {
    try {
      const claim = await this.claim(req);
      if (claim.kind === 'taken') return this.notice(req, ...this.alreadyNotice(claim.row));
      await this.run(req, claim.row);
    } catch (err) {
      this.logger.error({ msg: 'chat capture failed to start', answerId: req.answer.id, error: String(err) });
    }
  }

  private async run(req: CaptureRequest, capture: ChatCapture): Promise<void> {
    const drafting = t(req.kind === 'page' ? 'chat.capture.draftingPage' : 'chat.capture.draftingTerm');
    let placeholder: ChatMessageRef;
    try {
      placeholder = await req.adapter.postMessage(
        req.ctx,
        { chatId: req.answerMessage.chatId, replyToMessageId: req.answerMessage.messageId },
        req.adapter.render({ kind: 'notice', text: drafting }),
      );
    } catch (err) {
      await this.settleFailed(capture.id, String(err));
      return;
    }
    await this.prisma.chatCapture.update({ where: { id: capture.id }, data: { replyMessageId: placeholder.messageId } });

    try {
      const { text, button } = req.kind === 'page' ? await this.savePage(req, capture) : await this.saveTerm(req, capture);
      await this.show(req, placeholder, text, button);
    } catch (err) {
      if (err instanceof CaptureLost) return; // the sweeper's "never arrived" stays
      const key =
        err instanceof CaptureRefused
          ? err.key
          : err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS
            ? 'chat.answer.budget'
            : err instanceof ForbiddenException
              ? 'chat.capture.forbidden'
              : 'chat.capture.failed';
      this.logger.warn({ msg: 'chat capture failed', captureId: capture.id, error: String(err) });
      if (await this.settleFailed(capture.id, String(err))) {
        await this.show(req, placeholder, t(key, { workspace: req.workspaceName })).catch(() => undefined);
      }
    }
  }

  private async savePage(req: CaptureRequest, capture: ChatCapture): Promise<{ text: string; button: ChatLinkButton }> {
    const { principal } = req;
    const workspaceId = req.integration.workspaceId;
    const projectId = await this.projectFor(req);
    const transcript = await this.transcript(req);

    const agent = await this.agents.resolve(workspaceId, 'drafter');
    if (!agent.enabled || !agent.config.enabled) throw new CaptureRefused('chat.capture.disabled');
    await this.aiUsage.assertWithinBudget(workspaceId, principal.userId);
    const raw = await this.client.chat(
      { config: agent.config, userId: principal.userId, operation: 'chat-capture', locale: principal.locale },
      [
        { role: 'system', content: `${agent.instructions}\n\n${PAGE_FROM_CHAT}` },
        { role: 'user', content: wrapUntrusted(transcript.text, 'save_thread', 'chat') },
      ],
    );
    const { title, body } = splitDraft(raw, transcript.firstQuestion.slice(0, 120) || t('chat.capture.untitled'));
    if (!body) throw new CaptureRefused('chat.capture.failed');

    // The role again, now that the draft is in: it took a while, and nothing
    // is written on the strength of a check made before it.
    await this.access.requireRole(principal, workspaceId, 'editor');
    const mergeRequestId = await this.prisma.withTransaction(
      async () => {
        const created = await this.documents.createDocument({ workspaceId, projectId, title }, principal.userId);
        return openDraftMergeRequest(
          { prisma: this.prisma, storage: this.storage, documents: this.documents, mergeRequests: this.mergeRequests },
          {
            documentId: created.documentId,
            branch: `chat/${capture.id.slice(0, 8)}-${Date.now()}`,
            title,
            description: t('chat.capture.mrDescription', { platform: req.integration.name }),
            markdown: composeFrontmatter(body, { source: `chat:${req.integration.kind}`, generatedBy: agent.key }),
            userId: principal.userId,
            onCreated: (id) => this.settlePublished(capture.id, { title, documentId: created.documentId, mergeRequestId: id }),
          },
        );
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return {
      text: t('chat.capture.pageReady', { title }),
      button: { label: t('chat.capture.openMergeRequest'), url: `${this.webBaseUrl}/merge-requests/${mergeRequestId}` },
    };
  }

  /**
   * The glossarist's `suggest`, run over the conversation — the same pass the
   * glossary page runs over a draft, grounding included — and the most-used
   * term the project does not define yet, created switched off.
   */
  private async saveTerm(req: CaptureRequest, capture: ChatCapture): Promise<{ text: string; button: ChatLinkButton }> {
    const { principal } = req;
    const workspaceId = req.integration.workspaceId;
    const projectId = await this.projectFor(req);
    const transcript = await this.transcript(req);

    const result = await this.glossary.suggest(
      { workspaceId, projectId, markdown: wrapUntrusted(transcript.text, 'save_thread', 'chat') },
      principal,
    );
    if (!result.enabled) throw new CaptureRefused('chat.capture.disabled');
    const pick = result.suggestions.find((s) => !s.existingTermId);
    if (!pick) throw new CaptureRefused('chat.capture.noTerm');

    await this.access.requireRole(principal, workspaceId, 'editor');
    await this.prisma.withTransaction(async () => {
      const term = await this.glossary.create(
        {
          workspaceId,
          projectId,
          term: pick.term,
          definition: pick.definition,
          aliases: pick.aliases,
          source: 'ai',
          // Proposed, not adopted: a term links itself into every page that
          // uses it, so an editor turns it on in Settings → Glossary.
          enabled: false,
        },
        principal.userId,
      );
      await this.settlePublished(capture.id, { title: term.term, glossaryTermId: term.termId });
    });
    return {
      text: t('chat.capture.termReady', { term: pick.term }),
      button: { label: t('chat.capture.openGlossary'), url: `${this.webBaseUrl}/settings/glossary` },
    };
  }

  /** The group's project; in a DM, the workspace's first — where a page with no better home lands elsewhere too. */
  private async projectFor(req: CaptureRequest): Promise<string> {
    if (req.projectId) return req.projectId;
    const first = await this.prisma.project.findFirst({
      where: { workspaceId: req.integration.workspaceId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!first) throw new CaptureRefused('chat.capture.noProject');
    return first.id;
  }

  /** The conversation's turns that were posted in this chat, up to the answer Save was pressed under. */
  private async transcript(req: CaptureRequest): Promise<{ text: string; firstQuestion: string }> {
    const conversation = await this.prisma.chatConversation.findUnique({
      where: { id: req.answer.conversationId },
      select: { assistantThreadId: true },
    });
    const shown = await this.prisma.chatAnswer.findMany({
      where: {
        conversationId: req.answer.conversationId,
        status: 'answered',
        assistantMessageId: { not: null },
        createdAt: { lte: req.answer.createdAt },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_TURNS,
      select: { assistantMessageId: true },
    });
    if (!conversation || !shown.length) throw new CaptureRefused('chat.capture.nothing');
    const messages = await this.prisma.assistantMessage.findMany({
      where: { threadId: conversation.assistantThreadId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, role: true, content: true, sources: true },
    });
    const text = chatTranscript(messages, new Set(shown.map((s) => s.assistantMessageId!)));
    if (!text) throw new CaptureRefused('chat.capture.nothing');
    const firstQuestion = /^Question: (.*)$/m.exec(text)?.[1] ?? '';
    // Newest turns win when it is long: the question Save was pressed under is the last.
    return { text: text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text, firstQuestion };
  }

  /**
   * The pending row, once per answer and kind. A failed one is claimed again
   * in place by a guarded update, so pressing Save after a failure retries.
   */
  private async claim(req: CaptureRequest): Promise<{ kind: 'new' | 'taken'; row: ChatCapture }> {
    const data = { requestedBy: req.principal.userId, locale: req.locale };
    try {
      const row = await this.prisma.chatCapture.create({
        data: { workspaceId: req.integration.workspaceId, answerId: req.answer.id, kind: req.kind, ...data },
      });
      return { kind: 'new', row };
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
    }
    const key = { answerId_kind: { answerId: req.answer.id, kind: req.kind } };
    const retried = await this.prisma.chatCapture.updateMany({
      where: { answerId: req.answer.id, kind: req.kind, status: 'failed' },
      data: { ...data, status: 'pending', error: null, replyMessageId: null },
    });
    const row = await this.prisma.chatCapture.findUniqueOrThrow({ where: key });
    return { kind: retried.count === 1 ? 'new' : 'taken', row };
  }

  private alreadyNotice(row: ChatCapture): [string, ChatLinkButton?] {
    if (row.status !== 'published') return [t('chat.capture.inProgress')];
    if (row.mergeRequestId) {
      return [
        t('chat.capture.alreadySaved', { title: row.title ?? '' }),
        { label: t('chat.capture.openMergeRequest'), url: `${this.webBaseUrl}/merge-requests/${row.mergeRequestId}` },
      ];
    }
    return [
      t('chat.capture.alreadySaved', { title: row.title ?? '' }),
      { label: t('chat.capture.openGlossary'), url: `${this.webBaseUrl}/settings/glossary` },
    ];
  }

  /** pending → published, inside the publishing transaction; anything else rolls it back. */
  private async settlePublished(
    id: string,
    data: { title: string; documentId?: string; mergeRequestId?: string; glossaryTermId?: string },
  ): Promise<void> {
    const done = await this.prisma.chatCapture.updateMany({ where: { id, status: 'pending' }, data: { status: 'published', ...data } });
    if (done.count !== 1) throw new CaptureLost();
  }

  private async settleFailed(id: string, error: string): Promise<boolean> {
    const done = await this.prisma.chatCapture.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'failed', error: error.slice(0, 500) },
    });
    return done.count === 1;
  }

  private async notice(req: CaptureRequest, text: string, button?: ChatLinkButton): Promise<void> {
    await req.adapter
      .postMessage(
        req.ctx,
        { chatId: req.answerMessage.chatId, replyToMessageId: req.answerMessage.messageId },
        req.adapter.render({ kind: 'notice', text, ...(button ? { button } : {}) }),
      )
      .catch((err: unknown) => this.logger.warn({ msg: 'chat capture notice not delivered', error: String(err) }));
  }

  /** Edit "Drafting…" into the result; if it is gone, post the result instead. */
  private async show(req: CaptureRequest, placeholder: ChatMessageRef, text: string, button?: ChatLinkButton): Promise<void> {
    const msg = req.adapter.render({ kind: 'notice', text, ...(button ? { button } : {}) });
    try {
      await req.adapter.editMessage(req.ctx, placeholder, msg);
    } catch {
      await req.adapter.postMessage(req.ctx, { chatId: placeholder.chatId, replyToMessageId: req.answerMessage.messageId }, msg);
    }
  }

  /**
   * Captures with no progress for CHAT_CAPTURE_TIMEOUT_SECONDS: failed, and
   * "Drafting…" edited to say so in the language it was asked in. Measured
   * from `updatedAt`, because a retry claims the same row again.
   */
  async reapStale(): Promise<number> {
    const stale = await this.prisma.chatCapture.findMany({
      where: { status: 'pending', updatedAt: { lt: new Date(Date.now() - this.timeoutMs) } },
      include: { answer: { include: { integration: true } } },
      orderBy: { updatedAt: 'asc' },
      take: REAP_BATCH,
    });
    let closed = 0;
    for (const row of stale) {
      if (!(await this.settleFailed(row.id, 'timeout'))) continue;
      closed++;
      const integration = row.answer.integration;
      const ctx = this.integrations.context(integration);
      if (!ctx || !row.replyMessageId) continue;
      const adapter = this.registry.get(integration.kind);
      const lang = isLocale(row.locale) ? row.locale : 'en';
      try {
        await adapter.editMessage(
          ctx,
          { chatId: row.answer.externalChatId, messageId: row.replyMessageId },
          adapter.render({ kind: 'notice', text: withLocale(lang, () => t('chat.capture.timeout')) }),
        );
      } catch (err) {
        this.logger.warn({ msg: 'chat capture timeout notice not delivered', captureId: row.id, error: String(err) });
      }
    }
    return closed;
  }
}
