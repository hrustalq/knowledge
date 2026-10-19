import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ChatAnswer, type ChatChannelBinding, type ChatIntegration } from '@prisma/client';
import {
  ANSWER_FEEDBACK_REASONS,
  isLocale,
  isWebSource,
  type AssistantMessageInfo,
  type AssistantSource,
  type ChatPlatformKind,
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
import {
  ChatPlatformError,
  type ChatActionButton,
  type ChatAdapter,
  type ChatAdapterContext,
  type ChatInbound,
  type ChatMessageRef,
  type ChatView,
} from './adapters/chat-adapter.types.js';
import { decodeChatAction, encodeChatAction } from './chat-actions.js';
import { ChatBufferService, type BufferedThread } from './chat-buffer.service.js';
import { ChatCapturesService } from './chat-captures.service.js';
import { ChatIdentityService } from './chat-identity.service.js';
import { ChatIntegrationsService } from './chat-integrations.service.js';
import { HarvestRefused, HarvestService, type HarvestOutcome } from './harvest.service.js';
import { WORKSPACE_AUDIENCE } from '../permissions/access-scope.js';

/** A DM picks up where it left off within this window; after it, a new conversation. */
const DM_CONTINUATION_MS = 30 * 60_000;
/** Reaped per tick, at most — a backlog drains over a few minutes rather than in one burst of edits. */
const REAP_BATCH = 50;
/** Reasons for a 👎 per row of buttons — seven do not fit one row on a phone. */
const REASONS_PER_ROW = 2;

/**
 * The help each platform gets: Telegram's commands are `/slash`; Time's client
 * takes every leading `/` for itself, so its commands are plain words.
 */
const HELP_KEY: Record<ChatPlatformKind, string> = { telegram: 'chat.help', time: 'chat.helpTime' };

/** Which buttons sit under an answer: the vote row, the reasons for a 👎, or what to save it as. */
type AnswerButtons = 'vote' | 'reasons' | 'save';

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
  private readonly harvestEnabled: boolean;
  private readonly harvestMax: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly assistant: AssistantService,
    private readonly threads: AssistantThreadsService,
    private readonly registry: ChatAdapterRegistry,
    private readonly integrations: ChatIntegrationsService,
    private readonly identities: ChatIdentityService,
    private readonly feedback: AnswerFeedbackService,
    private readonly captures: ChatCapturesService,
    private readonly harvester: HarvestService,
    private readonly buffer: ChatBufferService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    this.maxSources = config.get('CHAT_MAX_SOURCES', { infer: true });
    this.ratePerMinute = config.get('CHAT_RATE_LIMIT_PER_USER_PER_MINUTE', { infer: true });
    this.timeoutMs = config.get('CHAT_ANSWER_TIMEOUT_SECONDS', { infer: true }) * 1000;
    this.harvestEnabled = config.get('HARVEST_ENABLED', { infer: true });
    this.harvestMax = config.get('HARVEST_MAX_MESSAGES', { infer: true });
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
    // A reaction is not addressed to the bot the way a command is: from anyone
    // but a linked editor it is just a reaction, and passes in silence.
    if (inbound.harvestReaction) return userId ? this.harvest(d, userId, locale) : undefined;

    // Kept for a harvest (#82): a DM's forwards wait for `/capture` instead of
    // being answered; a listening group's messages are kept and then handled
    // as usual. Masked on the way in, either way.
    if (this.harvestEnabled && !command && inbound.text) {
      if (inbound.isDm && inbound.forwardedFrom) {
        // The first of a batch is told how to finish; the rest are kept quietly.
        if (await this.buffer.holdForward(integration.id, inbound)) await this.notice(d, t('chat.harvest.forwardHeld'));
        return;
      }
      if (d.binding?.listening) {
        await this.buffer.holdGroupMessage(integration.id, d.binding, inbound).catch((err: unknown) => {
          this.logger.warn({ msg: 'chat message not kept', integrationId: integration.id, error: String(err) });
        });
      }
    }

    if (command) {
      switch (command.name) {
        case 'start':
        case 'help':
          if (inbound.isDm && !userId) return this.askToLink(d);
          return this.notice(d, this.help(d));
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
        case 'capture':
          return this.harvest(d, userId, locale);
        case 'forget': {
          // Anyone's right over their own messages: no link, no role.
          const removed = await this.buffer.forget(integration.id, inbound);
          return this.notice(d, removed ? t('chat.forget.done', { count: removed }) : t('chat.forget.nothing'));
        }
        case 'ask':
          // `/ask question` is a question, in any chat — what a group member
          // types when mentioning feels odd.
          return this.question(d, userId, locale, command.args, true);
        default:
          // Somebody else's command, or a typo. In a DM the help says what exists.
          return inbound.isDm ? this.notice(d, this.help(d)) : undefined;
      }
    }
    return this.question(d, userId, locale, inbound.text, inbound.mentioned || (await this.inBotThread(d)));
  }

  private help(d: Delivery): string {
    return t(HELP_KEY[d.integration.kind as ChatPlatformKind] ?? 'chat.help', { workspace: d.workspaceName });
  }

  /**
   * Is an unmentioned message part of an exchange with the bot? Telegram says
   * so itself (a reply to the bot's message comes marked `mentioned`). Time
   * gives only the thread, so the thread is checked against what the bot
   * answered in this chat: a thread it answered in, or one rooted at its own
   * reply. Anyone's — in a group, joining a thread with the bot is addressing it.
   */
  private async inBotThread(d: Delivery): Promise<boolean> {
    const { inbound, integration } = d;
    if (inbound.isDm || (!inbound.threadId && !inbound.replyToBotMessageId)) return false;
    const found = await this.prisma.chatAnswer.findFirst({
      where: {
        integrationId: integration.id,
        externalChatId: inbound.chatId,
        OR: [
          ...(inbound.threadId ? [{ threadId: inbound.threadId }] : []),
          ...(inbound.replyToBotMessageId ? [{ replyMessageId: inbound.replyToBotMessageId }] : []),
        ],
      },
      select: { id: true },
    });
    return !!found;
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
        {
          content: question,
          agentKey,
          projectId: binding?.projectId ?? null,
          // A group reads the answer, not only the asker (#76).
          ...(inbound.isDm ? {} : { audience: WORKSPACE_AUDIENCE }),
        },
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
          threadId: d.inbound.threadId,
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
   * answer they replied to, of their last question in this platform thread
   * (Time), or — in a DM — the one they were in a moment ago. Anything else
   * starts fresh. A reply to *somebody else's* answer starts fresh too: a
   * thread is one person's, and its history would otherwise leak.
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
    }
    if (!found && inbound.threadId) {
      const asked = await this.prisma.chatAnswer.findFirst({
        where: {
          integrationId: integration.id,
          externalChatId: inbound.chatId,
          threadId: inbound.threadId,
          askedBy: userId,
          conversationId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: { conversationId: true },
      });
      if (asked?.conversationId) {
        found = await this.prisma.chatConversation.findUnique({ where: { id: asked.conversationId } });
      }
    }
    if (!found && inbound.isDm) {
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
      actions: buttons === 'vote' ? voteRow(answerId) : buttons === 'reasons' ? reasonRows(answerId) : saveRows(answerId),
      webBaseUrl: this.webBaseUrl,
    };
  }

  /**
   * A press of a button under an answer: 👍, 👎, a reason for the 👎, Save and
   * what to save as, or back (issue #71, phase 2).
   *
   * The vote is the presser's, not the asker's — in a group anyone the answer
   * was shown to may rate it — so the presser meets the same bar a question
   * does: linked, and still a member of the workspace, checked on the press.
   * Votes go to `answer_feedback` under the `chat` surface, one per person per
   * answer, so a 👎 followed by its reason is one row, not two.
   *
   * A 👎 is recorded at once and the reasons are offered after it: a vote
   * whose reason is never picked is still a vote. Saving needs an editor, so
   * the menu is not even opened for anyone else. Every press is acknowledged,
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
      select: { id: true, assistantMessageId: true, conversationId: true, createdAt: true, locale: true },
    });
    const message = answer?.assistantMessageId
      ? await this.prisma.assistantMessage.findUnique({
          where: { id: answer.assistantMessageId },
          select: { id: true, threadId: true, content: true, sources: true, createdAt: true },
        })
      : null;
    if (!answer || !message) return ack(t('chat.feedback.gone'));
    const lang = isLocale(answer.locale) ? answer.locale : 'en';
    const rerender = (buttons: AnswerButtons) =>
      this.rerender(d, answer.id, message, lang, buttons).catch((err: unknown) => {
        this.logger.warn({ msg: 'chat answer buttons not updated', answerId: answer.id, error: String(err) });
      });

    if (action.kind === 'save-menu' || action.kind === 'capture') {
      try {
        await this.access.requireRole(principal, integration.workspaceId, 'editor');
      } catch {
        return ack(t('chat.capture.forbidden', { workspace: d.workspaceName }));
      }
      if (!answer.conversationId) return ack(t('chat.feedback.gone'));
      if (action.kind === 'save-menu') {
        await ack();
        return rerender('save');
      }
      await ack(t(action.capture === 'page' ? 'chat.capture.savingAnswer' : 'chat.capture.draftingTerm'));
      await rerender('vote');
      return this.captures.start({
        integration,
        adapter: d.adapter,
        ctx: d.ctx,
        answerMessage: { chatId: inbound.chatId, messageId: inbound.messageId },
        answer: { id: answer.id, conversationId: answer.conversationId, createdAt: answer.createdAt },
        message: { id: message.id, createdAt: message.createdAt },
        chatTitle: inbound.isDm ? null : (d.binding?.title ?? inbound.chatTitle),
        projectId: d.binding?.projectId ?? null,
        principal,
        kind: action.capture,
        workspaceName: d.workspaceName,
      });
    }

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
    await rerender(askReason ? 'reasons' : 'vote');
  }

  /** The answer again, from its stored message, in the language it was asked in, with other buttons. */
  private async rerender(
    d: Delivery,
    answerId: string,
    message: { threadId: string; content: string; sources: Prisma.JsonValue },
    lang: Locale,
    buttons: AnswerButtons,
  ): Promise<void> {
    const view = withLocale(lang, () =>
      this.answerView(
        { content: message.content, sources: (message.sources ?? []) as unknown as AssistantSource[] },
        message.threadId,
        answerId,
        buttons,
      ),
    );
    await d.adapter.editMessage(d.ctx, { chatId: d.inbound.chatId, messageId: d.inbound.messageId }, d.adapter.render(view));
  }

  /**
   * `capture` (#82): a thread, harvested into captures as the person who
   * asked — a linked editor, checked here and again by `CaptureService`. Time
   * fetches the thread the command was sent in; Telegram reads the group's
   * buffer from the message the command replies to, or in a private chat what
   * was just forwarded. The placeholder becomes counts and an inbox link,
   * never a capture's or a page's title: the group may hold people who cannot
   * open them. A refusal is said in the same place.
   *
   * A harvest reaction (📌 on Time, ✍ on Telegram) is the same request about
   * the message it was put on, except that nobody but a linked editor is
   * answered at all: a refusal to a reaction would be the bot talking to
   * people who were not talking to it.
   */
  private async harvest(d: Delivery, userId: string | null, locale: Locale): Promise<void> {
    const { inbound, integration, adapter } = d;
    const reaction = !!inbound.harvestReaction;
    if (!userId) return this.askToLink(d);
    let principal: Principal;
    try {
      principal = await this.access.principalFor(userId, locale);
      await this.access.requireRole(principal, integration.workspaceId, 'editor');
    } catch {
      return reaction ? undefined : this.notice(d, t('chat.harvest.forbidden', { workspace: d.workspaceName }));
    }
    if (!this.harvestEnabled) return reaction ? undefined : this.notice(d, t('chat.harvest.off'));

    let read: () => Promise<BufferedThread>;
    if (adapter.fetchThread) {
      // A reaction reads the whole thread of the post it is on. A command said
      // at the top of a channel is its own thread: there is nothing above it to read.
      const from = reaction ? inbound.messageId : inbound.threadId;
      if (!from || (!reaction && from === inbound.messageId)) return this.notice(d, t('chat.harvest.notInThread'));
      const before = reaction ? null : inbound.messageId;
      read = async () => ({
        thread: await adapter.fetchThread!(d.ctx, inbound.chatId, from, before, this.harvestMax),
        note: null,
        consumed: [],
      });
    } else if (inbound.isDm) {
      read = () => this.buffer.forwards(integration.id, inbound.chatId, this.harvestMax);
    } else {
      const asked = reaction ? await this.buffer.asReplyTo(integration.id, inbound) : inbound;
      if (!asked) return this.notice(d, t('chat.harvest.reactionNotKept', { count: this.buffer.ttlDays }));
      const m = asked.replyTo;
      if (!m) return this.notice(d, t('chat.harvest.replyFirst'));
      const url = adapter.messageUrl?.(inbound.chatId, m.messageId) ?? null;
      read = () => this.buffer.groupThread(integration.id, d.binding!, asked, this.harvestMax, url);
    }

    let placeholder: ChatMessageRef;
    try {
      placeholder = await this.post(d, { kind: 'notice', text: t('chat.harvest.reading') });
    } catch (err) {
      this.logger.warn({ msg: 'chat harvest placeholder not delivered', integrationId: integration.id, error: String(err) });
      return;
    }
    let view: ChatView;
    try {
      const { thread, note, consumed } = await read();
      const outcome = await this.harvester.harvest(
        {
          workspaceId: integration.workspaceId,
          projectId: d.binding?.projectId ?? null,
          platform: integration.kind as ChatPlatformKind,
          chatTitle: inbound.isDm ? null : (d.binding?.title ?? inbound.chatTitle),
          thread,
        },
        principal,
      );
      await this.buffer.consume(consumed);
      view = {
        kind: 'notice',
        text: harvestSummary(outcome, thread.truncated ? this.harvestMax - 1 : null, note),
        ...(outcome.proposed + outcome.duplicates ? { button: { label: t('chat.capture.openCaptures'), url: `${this.webBaseUrl}/captures` } } : {}),
      };
    } catch (err) {
      this.logger.warn({ msg: 'chat harvest failed', integrationId: integration.id, error: String(err) });
      view = { kind: 'notice', text: t(harvestRefusalKey(err), { workspace: d.workspaceName }) };
    }
    await this.show(d, placeholder, view).catch(() => undefined);
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

/**
 * What a harvest proposed, as counts only. `readReplies` is set when the
 * thread was cut to the cap; `note` says how a partial thread was read.
 */
export function harvestSummary(outcome: HarvestOutcome, readReplies: number | null, note: string | null = null): string {
  const parts = [
    outcome.proposed ? t('chat.harvest.proposed', { count: outcome.proposed }) : null,
    outcome.duplicates ? t('chat.harvest.duplicates', { count: outcome.duplicates }) : null,
    outcome.proposed + outcome.duplicates ? null : t('chat.harvest.nothing'),
    readReplies !== null ? t('chat.harvest.truncated', { count: readReplies }) : null,
    note,
  ];
  return parts.filter(Boolean).join(' ');
}

function harvestRefusalKey(err: unknown): string {
  if (err instanceof HarvestRefused) return err.key;
  if (err instanceof ChatPlatformError) return 'chat.harvest.unreadable';
  if (err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS) return 'chat.answer.budget';
  return 'chat.harvest.failed';
}

/** 👍 👎 and Save under an answer. The votes are emoji only: they read the same in every language. */
function voteRow(answerId: string): ChatActionButton[][] {
  return [
    [
      { label: '👍', action: encodeChatAction({ kind: 'vote', answerId, rating: 'up' }) },
      { label: '👎', action: encodeChatAction({ kind: 'vote', answerId, rating: 'down' }) },
      { label: t('chat.capture.save'), action: encodeChatAction({ kind: 'save-menu', answerId }) },
    ],
  ];
}

/** What to save the conversation as, one per row so the labels fit, and a way back. */
function saveRows(answerId: string): ChatActionButton[][] {
  return [
    [{ label: t('chat.capture.asPage'), action: encodeChatAction({ kind: 'capture', answerId, capture: 'page' }) }],
    [{ label: t('chat.capture.asTerm'), action: encodeChatAction({ kind: 'capture', answerId, capture: 'glossary-term' }) }],
    [{ label: t('chat.feedback.back'), action: encodeChatAction({ kind: 'back', answerId }) }],
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
