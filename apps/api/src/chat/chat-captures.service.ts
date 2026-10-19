import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatIntegration } from '@prisma/client';
import {
  isWebSource,
  type AssistantSource,
  type CaptureOrigin,
  type CaptureResult,
  type CaptureSession,
  type ChatCaptureKind,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Principal } from '../auth/principal.js';
import { CITE_MARKER_RE } from '../assistant/citations.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { CaptureInboxService } from '../captures/capture-inbox.service.js';
import { CaptureService } from '../captures/capture.service.js';
import { GlossaryService } from '../glossary/glossary.service.js';
import { t } from '../i18n/t.js';
import type { ChatAdapter, ChatAdapterContext, ChatLinkButton, ChatMessageRef } from './adapters/chat-adapter.types.js';

/** The newest turns of a conversation the glossarist reads; older ones are rarely what a term is about. */
const MAX_TURNS = 20;
/** What the glossarist is handed, at most. */
const MAX_TRANSCRIPT_CHARS = 24_000;
const SESSION: CaptureSession = { client: 'chat' };

/** A refusal with something to tell the person, as a message key. */
class CaptureRefused extends Error {
  constructor(readonly key: string) {
    super(key);
  }
}

export interface CaptureRequest {
  integration: ChatIntegration;
  adapter: ChatAdapter;
  ctx: ChatAdapterContext;
  /** The answer Save was pressed under; the result replies to it. */
  answerMessage: ChatMessageRef;
  answer: { id: string; conversationId: string; createdAt: Date };
  /** The assistant message the answer showed, and when it was written. */
  message: { id: string; createdAt: Date };
  /** The group's title; null in a DM. */
  chatTitle: string | null;
  /** The group's project, or null (a DM). */
  projectId: string | null;
  principal: Principal;
  kind: ChatCaptureKind;
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

/**
 * 💾 Save on a bot answer (issue #71, phase 2), as agent memory (#82): the
 * answer becomes an `answer` capture citing its pages — exactly the
 * assistant pane's "Save to knowledge base" — and a term the glossarist finds
 * in the conversation a `glossary` capture. Both then take the capture path
 * every agent's do: guards, rate limits, secret scan, dedupe, a merge request
 * with provenance `captured` or the Captures inbox, and the sweeper if a
 * restart strands one. There is no second save path to keep in step.
 *
 * As the person who pressed Save, who must be a linked editor — checked at the
 * press, and again by `CaptureService` before anything is written. The
 * capture carries a server-set {@link CaptureOrigin}: which chat, and when.
 *
 * The reply links what was proposed and never names a matched page: a group
 * may hold people who cannot open it.
 */
@Injectable()
export class ChatCapturesService {
  private readonly logger = new Logger(ChatCapturesService.name);
  private readonly webBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: CaptureInboxService,
    private readonly captures: CaptureService,
    private readonly glossary: GlossaryService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
  }

  /** One press of "Save as …". Never throws: it runs after the webhook has answered. */
  async start(req: CaptureRequest): Promise<void> {
    let reply: { text: string; button?: ChatLinkButton };
    try {
      reply = this.replyFor(req.kind === 'page' ? await this.saveAnswer(req) : await this.saveTerm(req));
    } catch (err) {
      this.logger.warn({ msg: 'chat capture refused', answerId: req.answer.id, error: String(err) });
      reply = { text: t(refusalKey(err), { workspace: req.workspaceName }) };
    }
    await req.adapter
      .postMessage(
        req.ctx,
        { chatId: req.answerMessage.chatId, replyToMessageId: req.answerMessage.messageId },
        req.adapter.render({ kind: 'notice', text: reply.text, ...(reply.button ? { button: reply.button } : {}) }),
      )
      .catch((err: unknown) => this.logger.warn({ msg: 'chat capture reply not delivered', error: String(err) }));
  }

  private saveAnswer(req: CaptureRequest): Promise<CaptureResult> {
    return this.inbox.fromAssistantMessage(req.message.id, req.projectId ? { projectId: req.projectId } : {}, req.principal, {
      session: SESSION,
      origin: this.origin(req),
    });
  }

  /**
   * The glossarist's `suggest`, run over the conversation — the same pass the
   * glossary page runs over a draft, grounding included — and the most-used
   * term the project does not define yet, proposed into the inbox.
   */
  private async saveTerm(req: CaptureRequest): Promise<CaptureResult> {
    const { principal } = req;
    const workspaceId = req.integration.workspaceId;
    const projectId = await this.projectFor(req);
    const transcript = await this.transcript(req);
    const result = await this.glossary.suggest(
      { workspaceId, projectId, markdown: wrapUntrusted(transcript, 'save_thread', 'chat') },
      principal,
    );
    if (!result.enabled) throw new CaptureRefused('chat.capture.disabled');
    const pick = result.suggestions.find((s) => !s.existingTermId);
    if (!pick) throw new CaptureRefused('chat.capture.noTerm');
    return this.captures.capture(
      {
        kind: 'glossary',
        workspaceId,
        projectId,
        term: pick.term,
        definition: pick.definition,
        ...(pick.aliases?.length ? { aliases: pick.aliases } : {}),
        session: SESSION,
      },
      principal,
      { origin: this.origin(req) },
    );
  }

  /** The question's arrival to the answer: the span the capture was taken from. */
  private origin(req: CaptureRequest): CaptureOrigin {
    return {
      platform: req.integration.kind,
      chatTitle: req.chatTitle,
      from: req.answer.createdAt.toISOString(),
      to: req.message.createdAt.toISOString(),
    };
  }

  /** Where it went, as a link — never a title. */
  private replyFor(result: CaptureResult): { text: string; button?: ChatLinkButton } {
    if (result.state === 'duplicate') {
      return {
        text: t('chat.capture.duplicate'),
        ...(result.webUrl
          ? { button: { label: t(result.mergeRequestId ? 'chat.capture.openMergeRequest' : 'chat.capture.openPage'), url: result.webUrl } }
          : {}),
      };
    }
    if (result.outcome === 'glossary') {
      return { text: t('chat.capture.termQueued'), button: { label: t('chat.capture.openCaptures'), url: `${this.webBaseUrl}/captures` } };
    }
    if (result.mergeRequestId && result.webUrl) {
      return { text: t('chat.capture.proposed'), button: { label: t('chat.capture.openMergeRequest'), url: result.webUrl } };
    }
    // Staged and not yet proposed: the capture sweeper drives it on.
    return { text: t('chat.capture.proposed'), button: { label: t('chat.capture.openCaptures'), url: `${this.webBaseUrl}/captures` } };
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
  private async transcript(req: CaptureRequest): Promise<string> {
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
    // Newest turns win when it is long: the question Save was pressed under is the last.
    return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text;
  }
}

/** A refusal's message key, from the capture path's `reason` where it gave one. */
function refusalKey(err: unknown): string {
  if (err instanceof CaptureRefused) return err.key;
  if (!(err instanceof HttpException)) return 'chat.capture.failed';
  const body = err.getResponse();
  const reason = typeof body === 'object' && body !== null ? (body as { reason?: unknown }).reason : undefined;
  switch (reason) {
    case 'capture-no-citations':
      return 'chat.capture.noPages';
    case 'capture-unreadable-pages':
      return 'chat.capture.unreadable';
    case 'capture-secret':
      return 'chat.capture.secret';
    case 'capture-rate-limited':
      return 'chat.capture.rateLimited';
    case 'capture-disabled':
      return 'chat.capture.capturesOff';
  }
  if (err.getStatus() === HttpStatus.TOO_MANY_REQUESTS) return 'chat.answer.budget';
  if (err.getStatus() === HttpStatus.FORBIDDEN) return 'chat.capture.forbidden';
  return 'chat.capture.failed';
}
