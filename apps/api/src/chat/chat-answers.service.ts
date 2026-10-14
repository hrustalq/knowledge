import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ChatAnswer, type ChatChannelBinding, type ChatIntegration } from '@prisma/client';
import {
  ANSWER_FEEDBACK_REASONS,
  isLocale,
  isWebSource,
  type AssistantMessageInfo,
  type AssistantSource,
  type Locale,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { AssistantService } from '../assistant/assistant.service.js';
import { AssistantThreadsService } from '../assistant/assistant-threads.service.js';
import { CITE_MARKER_RE } from '../assistant/citations.js';
import { AnswerFeedbackService } from '../feedback/answer-feedback.service.js';
import { t, withLocale } from '../i18n/t.js';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry.js';
import type {
  ChatActionButton,
  ChatAdapter,
  ChatAdapterContext,
  ChatInbound,
  ChatMessageRef,
  ChatView,
} from './adapters/chat-adapter.types.js';
import { decodeChatAction, encodeChatAction } from './chat-actions.js';
import { ChatIdentityService } from './chat-identity.service.js';
import { ChatIntegrationsService } from './chat-integrations.service.js';

/** A DM picks up where it left off within this window; after it, a new conversation. */
const DM_CONTINUATION_MS = 30 * 60_000;
/** Reaped per tick, at most — a backlog drains over a few minutes rather than in one burst of edits. */
const REAP_BATCH = 50;
/** Reasons for a 👎 per row of buttons — seven do not fit one row on a phone. */
const REASONS_PER_ROW = 2;

/** Which buttons sit under an answer: the vote row, or — after a 👎 — the reasons. */
type AnswerButtons = 'vote' | 'reasons';

interface Delivery {
  integration: ChatIntegration;
  adapter: ChatAdapter;
  ctx: ChatAdapterContext;
  inbound: ChatInbound;
  binding: ChatChannelBinding | null;
  workspaceName: string;
}

/**
 * Answering in a chat (issue #71).
 *
 * ## Where the answer runs
 *
 * In the API, on a detached continuation — the feature-21 @mention shape, not
 * the worker. A chat turn is the pane's turn (`AssistantService.runChatTurn`),
 * and that service needs `AssistantToolsService`, whose dependencies are
 * API-only. The webhook verifies, hands the delivery here and returns 200 at
 * once; the `pending` row is the claim that makes a redelivery answer once, and
 * {@link reapStale} closes out whatever a restart drops.
 *
 * ## Who the answer runs as
 *
 * Always a linked person, through `principalFor` and `requireRole` checked on
 * every message — there is no bot principal and no anonymous answer. An
 * account that is not linked gets the link instruction and nothing else: no
 * model call, no claim row.
 */
@Injectable()
export class ChatAnswersService {
  private readonly logger = new Logger(ChatAnswersService.name);
  private readonly webBaseUrl: string;
  private readonly maxSources: number;
  private readonly ratePerMinute: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly assistant: AssistantService,
    private readonly threads: AssistantThreadsService,
    private readonly registry: ChatAdapterRegistry,
    private readonly integrations: ChatIntegrationsService,
    private readonly identities: ChatIdentityService,
    private readonly feedback: AnswerFeedbackService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    this.maxSources = config.get('CHAT_MAX_SOURCES', { infer: true });
    this.ratePerMinute = config.get('CHAT_RATE_LIMIT_PER_USER_PER_MINUTE', { infer: true });
    this.timeoutMs = config.get('CHAT_ANSWER_TIMEOUT_SECONDS', { infer: true }) * 1000;
  }

  /**
   * One verified message. Never throws: it runs after the webhook has already
   * answered, so there is nobody left to throw to — failures are logged, and
   * the asker is told wherever there is a message to tell them in.
   */
  async receive(integration: ChatIntegration, inbound: ChatInbound): Promise<void> {
    try {
      const ctx = this.integrations.context(integration);
      if (!ctx) return;
      const binding = inbound.isDm ? null : await this.integrations.findBinding(integration.id, inbound.chatId);
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: integration.workspaceId },
        select: { name: true },
      });
      const delivery: Delivery = {
        integration,
        adapter: this.registry.get(integration.kind),
        ctx,
        inbound,
        binding,
        workspaceName: workspace?.name ?? '',
      };
      const identity = await this.identities.resolve(integration.id, inbound.externalUserId);
      const userLocale = identity
        ? ((await this.prisma.user.findUnique({ where: { id: identity.userId }, select: { locale: true } }))?.locale ?? null)
        : null;
      // The asker's own language when they have one; then the channel's; then the bot's.
      const locale = [userLocale, binding?.locale, integration.locale].find(isLocale) ?? 'en';
      await withLocale(locale, () => this.dispatch(delivery, identity?.userId ?? null, locale));
    } catch (err) {
      this.logger.error({ msg: 'chat delivery failed', integrationId: integration.id, error: String(err) });
    }
  }

  private async dispatch(d: Delivery, userId: string | null, locale: Locale): Promise<void> {
    const { inbound, integration } = d;
    // A button only ever comes from a message the bot posted, and the answer
    // it names is looked up in this chat — so it is handled even where the
    // group has since been unbound: the press must at least be acknowledged.
    if (inbound.action) return this.action(d, userId, locale);
    const command = inbound.command;
    // A group nobody bound is a group the bot was added to and nothing more:
    // silence, so a stray bot cannot be made to talk anywhere. `/bind` is the
    // one way in, and it checks who is asking.
    if (!inbound.isDm && !d.binding && command?.name !== 'bind') return;

    if (command) {
      switch (command.name) {
        case 'start':
        case 'help':
          if (inbound.isDm && !userId) return this.askToLink(d);
          return this.notice(d, t('chat.help', { workspace: d.workspaceName }));
        case 'new':
          if (!userId) return inbound.isDm ? this.askToLink(d) : undefined;
          // Ages the asker's conversations here out of the continuation window
          // rather than deleting them: the threads stay in /assistant.
          await this.prisma.chatConversation.updateMany({
            where: { integrationId: integration.id, externalChatId: inbound.chatId, userId },
            data: { lastActivityAt: new Date(0) },
          });
          return this.notice(d, t('chat.conversation.new'));
        case 'unlink': {
          if (!inbound.isDm) return;
          const removed = await this.identities.unlinkExternal(integration.id, inbound.externalUserId);
          return this.notice(d, t(removed ? 'chat.link.unlinked' : 'chat.link.notLinked'));
        }
        case 'bind':
        case 'unbind':
          return this.bindCommand(d, userId, command.name);
        case 'ask':
          // `/ask question` is a question, in any chat — what a group member
          // types when mentioning feels odd.
          return this.question(d, userId, locale, command.args, true);
        default:
          // Somebody else's command, or a typo. In a DM the help says what exists.
          return inbound.isDm ? this.notice(d, t('chat.help', { workspace: d.workspaceName })) : undefined;
      }
    }
    return this.question(d, userId, locale, inbound.text, inbound.mentioned);
  }

  private async question(d: Delivery, userId: string | null, locale: Locale, text: string, addressed: boolean): Promise<void> {
    const { inbound, integration, binding } = d;
    if (!inbound.isDm) {
      if (!binding || binding.answerMode === 'off') return;
      if (binding.answerMode === 'mention' && !addressed) return;
    }
    if (!userId) {
      // In `all` mode an unaddressed message from an unlinked member is just
      // chatter — prompting each one to link would be spam.
      if (!inbound.isDm && !addressed) return;
      return this.askToLink(d);
    }
    const question = text.trim();
    if (!question) return this.notice(d, t('chat.answer.empty'));

    let principal: Principal;
    try {
      principal = await this.access.principalFor(userId, locale);
      await this.access.requireRole(principal, integration.workspaceId, 'viewer');
    } catch {
      return this.notice(d, t('chat.answer.noAccess', { workspace: d.workspaceName }));
    }

    // Counted from the claims themselves — no counter to keep in step.
    const recent = await this.prisma.chatAnswer.count({
      where: { askedBy: userId, createdAt: { gt: new Date(Date.now() - 60_000) } },
    });
    if (recent >= this.ratePerMinute) return this.notice(d, t('chat.answer.rateLimited'));

    const agentKey = binding?.agentKey ?? integration.defaultAgentKey ?? 'researcher';
    const claim = await this.claim(d, userId, agentKey, locale);
    if (!claim) return;

    let placeholder: ChatMessageRef;
    try {
      placeholder = await this.post(d, { kind: 'notice', text: t('chat.answer.thinking') });
    } catch (err) {
      await this.settle(claim.id, 'failed', { error: String(err).slice(0, 500) });
      return;
    }
    await this.prisma.chatAnswer.update({ where: { id: claim.id }, data: { replyMessageId: placeholder.messageId } });

    try {
      const conversation = await this.conversationFor(d, userId, question);
      await this.prisma.chatAnswer.update({ where: { id: claim.id }, data: { conversationId: conversation.id } });
      const turn = await this.assistant.runChatTurn(
        conversation.assistantThreadId,
        { content: question, agentKey, projectId: binding?.projectId ?? null },
        principal,
      );
      const view: ChatView = turn.enabled
        ? this.answerView(turn.message, conversation.assistantThreadId, claim.id)
        : { kind: 'notice', text: t('chat.answer.disabled', { workspace: d.workspaceName }) };
      // Claim the result before showing it: if the reaper already gave up on
      // this question, its "never arrived" stays — the answer is in /assistant.
      if (!(await this.settle(claim.id, 'answered', { assistantMessageId: turn.enabled ? turn.message.id : null }))) return;
      await this.show(d, placeholder, view);
    } catch (err) {
      const key =
        err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS
          ? 'chat.answer.budget'
          : err instanceof ForbiddenException
            ? 'chat.answer.noAccess'
            : 'chat.answer.failed';
      this.logger.warn({ msg: 'chat answer failed', integrationId: integration.id, answerId: claim.id, error: String(err) });
      if (await this.settle(claim.id, 'failed', { error: String(err).slice(0, 500) })) {
        await this.show(d, placeholder, { kind: 'notice', text: t(key, { workspace: d.workspaceName }) }).catch(() => undefined);
      }
    }
  }

  /**
   * The pending row, inserted once per (bot, chat, message). A platform that
   * redelivers an update it thinks timed out hits the unique key and stops here.
   */
  private async claim(d: Delivery, userId: string, agentKey: string, locale: Locale): Promise<ChatAnswer | null> {
    try {
      return await this.prisma.chatAnswer.create({
        data: {
          workspaceId: d.integration.workspaceId,
          integrationId: d.integration.id,
          externalChatId: d.inbound.chatId,
          inboundMessageId: d.inbound.messageId,
          askedBy: userId,
          agentKey,
          locale,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    }
  }

  /** pending → answered | failed, once. False when somebody (the reaper) settled it first. */
  private async settle(
    id: string,
    status: 'answered' | 'failed',
    data: { assistantMessageId?: string | null; error?: string },
  ): Promise<boolean> {
    const done = await this.prisma.chatAnswer.updateMany({ where: { id, status: 'pending' }, data: { status, ...data } });
    return done.count === 1;
  }

  /**
   * The asker's own assistant thread for this question: the conversation of the
   * answer they replied to, or — in a DM — the one they were in a moment ago.
   * Anything else starts fresh. A reply to *somebody else's* answer starts
   * fresh too: a thread is one person's, and its history would otherwise leak.
   */
  private async conversationFor(d: Delivery, userId: string, question: string) {
    const { integration, inbound } = d;
    let found = null;
    if (inbound.replyToBotMessageId) {
      const answered = await this.prisma.chatAnswer.findFirst({
        where: {
          integrationId: integration.id,
          externalChatId: inbound.chatId,
          replyMessageId: inbound.replyToBotMessageId,
          askedBy: userId,
          conversationId: { not: null },
        },
        select: { conversationId: true },
      });
      if (answered?.conversationId) {
        found = await this.prisma.chatConversation.findUnique({ where: { id: answered.conversationId } });
      }
    } else if (inbound.isDm) {
      found = await this.prisma.chatConversation.findFirst({
        where: {
          integrationId: integration.id,
          externalChatId: inbound.chatId,
          userId,
          lastActivityAt: { gt: new Date(Date.now() - DM_CONTINUATION_MS) },
        },
        orderBy: { lastActivityAt: 'desc' },
      });
    }
    if (found) {
      return this.prisma.chatConversation.update({ where: { id: found.id }, data: { lastActivityAt: new Date() } });
    }
    const { thread } = await this.threads.createThread(integration.workspaceId, userId, {
      title: question.slice(0, 80),
    });
    return this.prisma.chatConversation.create({
      data: {
        integrationId: integration.id,
        workspaceId: integration.workspaceId,
        externalChatId: inbound.chatId,
        userId,
        assistantThreadId: thread.id,
      },
    });
  }

  /**
   * The answer and the sources it rests on. Cited sources first, in the order
   * the answer cites them, then whatever else the turn gathered, up to
   * CHAT_MAX_SOURCES — a chat shows a few links, not the turn's whole reading list.
   *
   * Built the same way every time it is shown: a vote that swaps the buttons
   * re-renders the whole answer from the stored message rather than editing
   * the keyboard alone, because only the adapter knows whether it had to cut
   * the answer and add "Open the full answer".
   */
  answerView(
    message: Pick<AssistantMessageInfo, 'content' | 'sources'>,
    threadId: string,
    answerId: string,
    buttons: AnswerButtons = 'vote',
  ): ChatView {
    const cited = new Set<string>();
    for (const m of message.content.matchAll(new RegExp(CITE_MARKER_RE.source, 'gi'))) {
      for (const label of m[1].split(/\s*[,;]\s*/)) cited.add(label.toUpperCase());
    }
    const isCited = (s: AssistantSource) => !!s.cite && cited.has(s.cite.toUpperCase());
    const ordered = [...message.sources.filter(isCited), ...message.sources.filter((s) => !isCited(s))];
    return {
      kind: 'answer',
      answer: message.content,
      sources: ordered.slice(0, this.maxSources).map((s) => ({
        ...(s.cite ? { cite: s.cite } : {}),
        title: s.title,
        url: isWebSource(s) ? s.url : `${this.webBaseUrl}/documents/${s.documentId}`,
      })),
      sourcesHeading: t('chat.answer.sources'),
      full: { label: t('chat.answer.openFull'), url: `${this.webBaseUrl}/assistant?thread=${threadId}` },
      actions: buttons === 'vote' ? voteRow(answerId) : reasonRows(answerId),
      webBaseUrl: this.webBaseUrl,
    };
  }

  /**
   * A press of a button under an answer: 👍, 👎, a reason for the 👎, or back
   * (issue #71, phase 2).
   *
   * The vote is the presser's, not the asker's — in a group anyone the answer
   * was shown to may rate it — so the presser meets the same bar a question
   * does: linked, and still a member of the workspace, checked on the press.
   * Votes go to `answer_feedback` under the `chat` surface, one per person per
   * answer, so a 👎 followed by its reason is one row, not two.
   *
   * A 👎 is recorded at once and the reasons are offered after it: a vote
   * whose reason is never picked is still a vote. Every press is acknowledged,
   * because the platform shows a spinner on the button until it is.
   */
  private async action(d: Delivery, userId: string | null, locale: Locale): Promise<void> {
    const { inbound, integration } = d;
    const press = inbound.action!;
    const ack = (note?: string) =>
      d.adapter.acknowledge(d.ctx, press.id, note).catch((err: unknown) => {
        this.logger.warn({ msg: 'chat button press not acknowledged', integrationId: integration.id, error: String(err) });
      });

    const action = decodeChatAction(press.data);
    if (!action) return ack();
    if (!userId) return ack(t('chat.feedback.linkFirst'));
    let principal: Principal;
    try {
      principal = await this.access.principalFor(userId, locale);
      await this.access.requireRole(principal, integration.workspaceId, 'viewer');
    } catch {
      return ack(t('chat.answer.noAccess', { workspace: d.workspaceName }));
    }

    // Looked up in the chat the press came from: an id from elsewhere is not found.
    const answer = await this.prisma.chatAnswer.findFirst({
      where: { id: action.answerId, integrationId: integration.id, externalChatId: inbound.chatId, status: 'answered' },
      select: { id: true, assistantMessageId: true, locale: true },
    });
    const message = answer?.assistantMessageId
      ? await this.prisma.assistantMessage.findUnique({
          where: { id: answer.assistantMessageId },
          select: { id: true, threadId: true, content: true, sources: true },
        })
      : null;
    if (!answer || !message) return ack(t('chat.feedback.gone'));

    if (action.kind !== 'back') {
      try {
        await this.feedback.vote(message.id, principal, {
          rating: action.kind === 'vote' ? action.rating : 'down',
          ...(action.kind === 'reason' ? { reason: action.reason } : {}),
          surface: 'chat',
        });
      } catch (err) {
        if (err instanceof ForbiddenException) return ack(t('chat.feedback.disabled'));
        this.logger.warn({ msg: 'chat vote failed', integrationId: integration.id, answerId: answer.id, error: String(err) });
        return ack(t('chat.feedback.failed'));
      }
    }

    const askReason = action.kind === 'vote' && action.rating === 'down';
    await ack(askReason ? t('chat.feedback.askReason') : action.kind === 'back' ? undefined : t('chat.feedback.thanks'));
    // 👍 leaves the buttons as they are; 👎 swaps in the reasons; a reason or
    // back puts the vote row back. The answer keeps the language it was asked
    // in, whoever pressed.
    if (action.kind === 'vote' && !askReason) return;
    const lang = isLocale(answer.locale) ? answer.locale : 'en';
    const view = withLocale(lang, () =>
      this.answerView(
        { content: message.content, sources: (message.sources ?? []) as unknown as AssistantSource[] },
        message.threadId,
        answer.id,
        askReason ? 'reasons' : 'vote',
      ),
    );
    await d.adapter
      .editMessage(d.ctx, { chatId: inbound.chatId, messageId: inbound.messageId }, d.adapter.render(view))
      .catch((err: unknown) => {
        this.logger.warn({ msg: 'chat answer buttons not updated', answerId: answer.id, error: String(err) });
      });
  }

  /** Link instruction. A code only ever goes into a private chat; a group gets "message me". */
  private async askToLink(d: Delivery): Promise<void> {
    const { inbound, integration, adapter } = d;
    if (!inbound.isDm) {
      const direct = adapter.directLink(integration.botUsername);
      return this.notice(d, t('chat.link.inGroup'), direct ? { label: t('chat.link.openPrivate'), url: direct } : undefined);
    }
    const { url, minutes } = await this.identities.issueCode(integration, inbound);
    return this.notice(d, t('chat.link.required', { workspace: d.workspaceName, minutes }), {
      label: t('chat.link.button'),
      url,
    });
  }

  /** `/bind`, `/unbind`: a linked person who is an admin of the bot's workspace, in a group. */
  private async bindCommand(d: Delivery, userId: string | null, name: 'bind' | 'unbind'): Promise<void> {
    const { inbound, integration } = d;
    if (inbound.isDm) return this.notice(d, t('chat.bind.dmOnly'));
    if (!userId) return this.notice(d, t('chat.bind.forbidden'));
    try {
      const principal = await this.access.principalFor(userId, 'en');
      await this.access.requireRole(principal, integration.workspaceId, 'admin');
    } catch {
      return this.notice(d, t('chat.bind.forbidden'));
    }
    if (name === 'bind') {
      const result = await this.integrations.bindFromChat(integration, { chatId: inbound.chatId, title: inbound.chatTitle }, userId);
      return this.notice(d, t(result === 'created' ? 'chat.bind.done' : 'chat.bind.already'));
    }
    const removed = await this.integrations.unbindFromChat(integration.id, inbound.chatId);
    return this.notice(d, t(removed ? 'chat.bind.removed' : 'chat.bind.notBound'));
  }

  private async notice(d: Delivery, text: string, button?: { label: string; url: string }): Promise<void> {
    try {
      await this.post(d, { kind: 'notice', text, ...(button ? { button } : {}) });
    } catch (err) {
      this.logger.warn({ msg: 'chat notice not delivered', integrationId: d.integration.id, error: String(err) });
    }
  }

  private post(d: Delivery, view: ChatView): Promise<ChatMessageRef> {
    return d.adapter.postMessage(
      d.ctx,
      { chatId: d.inbound.chatId, replyToMessageId: d.inbound.messageId },
      d.adapter.render(view),
    );
  }

  /** Edit the placeholder into the result; if it is gone (deleted, too old), post the result instead. */
  private async show(d: Delivery, placeholder: ChatMessageRef, view: ChatView): Promise<void> {
    const msg = d.adapter.render(view);
    try {
      await d.adapter.editMessage(d.ctx, placeholder, msg);
    } catch {
      await d.adapter.postMessage(d.ctx, { chatId: placeholder.chatId, replyToMessageId: d.inbound.messageId }, msg);
    }
  }

  /**
   * Questions still pending past CHAT_ANSWER_TIMEOUT_SECONDS: failed, and the
   * placeholder edited to say so in the language it was asked in. Each row is
   * settled with the same guarded update the answer path uses, so a late
   * answer and the reaper can never both win.
   */
  async reapStale(): Promise<number> {
    const stale = await this.prisma.chatAnswer.findMany({
      where: { status: 'pending', createdAt: { lt: new Date(Date.now() - this.timeoutMs) } },
      include: { integration: true },
      orderBy: { createdAt: 'asc' },
      take: REAP_BATCH,
    });
    let closed = 0;
    for (const row of stale) {
      if (!(await this.settle(row.id, 'failed', { error: 'timeout' }))) continue;
      closed++;
      const ctx = this.integrations.context(row.integration);
      if (!ctx || !row.replyMessageId) continue;
      const adapter = this.registry.get(row.integration.kind);
      const lang = isLocale(row.locale) ? row.locale : 'en';
      try {
        await adapter.editMessage(
          ctx,
          { chatId: row.externalChatId, messageId: row.replyMessageId },
          adapter.render({ kind: 'notice', text: t('chat.answer.timeout', undefined, lang) }),
        );
      } catch (err) {
        this.logger.warn({ msg: 'chat timeout notice not delivered', answerId: row.id, error: String(err) });
      }
    }
    return closed;
  }
}

/** 👍 👎 under an answer. Emoji only: they read the same in every language. */
function voteRow(answerId: string): ChatActionButton[][] {
  return [
    [
      { label: '👍', action: encodeChatAction({ kind: 'vote', answerId, rating: 'up' }) },
      { label: '👎', action: encodeChatAction({ kind: 'vote', answerId, rating: 'down' }) },
    ],
  ];
}

/** What was wrong — `ANSWER_FEEDBACK_REASONS`, the reasons every other surface offers — and a way back. */
function reasonRows(answerId: string): ChatActionButton[][] {
  const buttons = ANSWER_FEEDBACK_REASONS.map((reason) => ({
    label: t(`chat.feedback.reason.${reason}`),
    action: encodeChatAction({ kind: 'reason', answerId, reason }),
  }));
  const rows: ChatActionButton[][] = [];
  for (let i = 0; i < buttons.length; i += REASONS_PER_ROW) rows.push(buttons.slice(i, i + REASONS_PER_ROW));
  rows.push([{ label: t('chat.feedback.back'), action: encodeChatAction({ kind: 'back', answerId }) }]);
  return rows;
}
