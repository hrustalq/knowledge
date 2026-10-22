import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatChannelBinding } from '@prisma/client';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/t.js';
import type { ChatInbound, ChatThread, ChatThreadMessage } from './adapters/chat-adapter.types.js';
import { createMasker } from './harvest-mask.js';
import { HarvestRefused } from './harvest.service.js';

const DAY_MS = 86_400_000;

/** A thread read from the buffer, and what the reply should add about how it was read. */
export interface BufferedThread {
  thread: ChatThread;
  /** Already in the reply's language; null when the thread is what was asked for. */
  note: string | null;
  /** Rows a successful harvest uses up (a DM's forwards); a group's rows stay for the next one. */
  consumed: string[];
}

/** One listening thread with messages its automatic harvest (#340) has not read. */
export interface ListenedThread {
  bindingId: string;
  /** The forum topic; '' outside one. */
  topicKey: string;
  /** Kept messages newer than the mark and the switch. */
  fresh: number;
  /** `created_at` of the newest of them. */
  newestAt: Date;
  /** The mark as read; null when this thread was never harvested automatically. */
  through: Date | null;
}

/**
 * Where a Telegram harvest (#82, phase 3) gets its thread, since Telegram has
 * no thread to fetch: a listening group's kept messages, or what a person
 * forwarded to the bot in a private chat.
 *
 * Every row is masked before it is written, with a fresh masker per message
 * — placeholders are numbered per message, and the raw text never reaches the
 * table. Nothing here is searched or indexed: the only reader is a harvest.
 * Rows go after CHAT_LISTEN_TTL_DAYS (group) or HARVEST_FORWARD_WINDOW_SEC
 * (DM) on the answer sweeper's tick, with their binding, when listening is
 * turned off, and per author on `/forget`.
 */
@Injectable()
export class ChatBufferService {
  private readonly ttlMs: number;
  private readonly windowMs: number;
  /** CHAT_LISTEN_TTL_DAYS, which the replies quote. */
  readonly ttlDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlDays = config.get('CHAT_LISTEN_TTL_DAYS', { infer: true });
    this.ttlMs = this.ttlDays * DAY_MS;
    this.windowMs = config.get('HARVEST_FORWARD_WINDOW_SEC', { infer: true }) * 1000;
  }

  /** One message of a listening group, masked. A redelivery is a no-op. */
  async holdGroupMessage(integrationId: string, binding: ChatChannelBinding, inbound: ChatInbound): Promise<void> {
    await this.prisma.chatBufferedMessage.createMany({
      data: [
        {
          integrationId,
          bindingId: binding.id,
          externalChatId: inbound.chatId,
          topicId: inbound.topicId ?? null,
          externalMessageId: inbound.messageId,
          authorId: inbound.externalUserId,
          text: createMasker()(inbound.text),
          sentAt: inbound.at ?? new Date(),
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * A message forwarded to the bot in a private chat, masked, under its
   * original author and time. True when it opens a batch — nothing else was
   * forwarded within the window — so the bot says once how to finish.
   */
  async holdForward(integrationId: string, inbound: ChatInbound): Promise<boolean> {
    const open = await this.prisma.chatBufferedMessage.count({ where: this.forwardsWhere(integrationId, inbound.chatId) });
    await this.prisma.chatBufferedMessage.createMany({
      data: [
        {
          integrationId,
          externalChatId: inbound.chatId,
          externalMessageId: inbound.messageId,
          authorId: inbound.forwardedFrom!.authorId,
          text: createMasker()(inbound.text),
          sentAt: inbound.forwardedFrom!.at,
        },
      ],
      skipDuplicates: true,
    });
    return open === 0;
  }

  /** `/capture` in a private chat: exactly what was forwarded within the window, oldest first. */
  async forwards(integrationId: string, chatId: string, max: number): Promise<BufferedThread> {
    const rows = await this.prisma.chatBufferedMessage.findMany({
      where: this.forwardsWhere(integrationId, chatId),
      orderBy: [{ sentAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, authorId: true, text: true, sentAt: true },
    });
    if (!rows.length) throw new HarvestRefused('chat.harvest.forwardFirst');
    const kept = rows.length > max ? [rows[0]!, ...rows.slice(-(max - 1))] : rows;
    return {
      thread: { messages: kept.map(toMessage), url: null, truncated: rows.length > max },
      note: null,
      consumed: rows.map((r) => r.id),
    };
  }

  /**
   * `/capture` replying to message M in a group: M, then what this group (or
   * forum topic) said from M up to the command. M's text comes from the reply
   * itself, as Telegram delivered it; the rest only from the buffer. With
   * listening off that is M alone, and with M older than the buffer it is M
   * and whatever is still kept — the note says which, so nobody mistakes a
   * partial read for the whole thread.
   */
  async groupThread(
    integrationId: string,
    binding: ChatChannelBinding,
    inbound: ChatInbound,
    max: number,
    url: string | null,
  ): Promise<BufferedThread> {
    const m = inbound.replyTo!;
    const head: ChatThreadMessage[] = m.text && !m.fromBot ? [{ authorId: m.authorId, text: m.text, at: m.at }] : [];
    if (!binding.listening) {
      return { thread: { messages: head, url, truncated: false }, note: t('chat.harvest.listeningOff'), consumed: [] };
    }
    const scope = { integrationId, externalChatId: inbound.chatId };
    const newest = await this.prisma.chatBufferedMessage.findMany({
      where: {
        ...scope,
        topicId: inbound.topicId ?? null,
        // M is excluded only when its text came with the command: on Teams it did not, and M is a kept row.
        externalMessageId: { notIn: head.length ? [m.messageId, inbound.messageId] : [inbound.messageId] },
        sentAt: { gte: m.at, ...(inbound.at ? { lte: inbound.at } : {}) },
      },
      orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
      take: max,
      select: { authorId: true, text: true, sentAt: true },
    });
    const truncated = newest.length > max - 1;
    const replies = newest.slice(0, max - 1).reverse().map(toMessage);
    const held = head.length ? await this.prisma.chatBufferedMessage.count({ where: { ...scope, externalMessageId: m.messageId } }) : 1;
    return {
      thread: { messages: [...head, ...replies], url, truncated },
      note: held ? null : t('chat.harvest.beforeBuffer', { count: this.ttlDays }),
      consumed: [],
    };
  }

  /**
   * ✍ on message M (#82, phase 4) as the `/capture` that replies to M: the
   * reaction carries no text, so M must still be kept. Null when it is not —
   * listening off, M older than the buffer, or M a message the bot never saw.
   */
  async asReplyTo(integrationId: string, inbound: ChatInbound): Promise<ChatInbound | null> {
    const m = await this.prisma.chatBufferedMessage.findFirst({
      where: { integrationId, externalChatId: inbound.chatId, externalMessageId: inbound.messageId, bindingId: { not: null } },
      select: { authorId: true, text: true, sentAt: true, topicId: true },
    });
    if (!m) return null;
    return {
      ...inbound,
      topicId: m.topicId,
      replyTo: { messageId: inbound.messageId, authorId: m.authorId, text: m.text, at: m.sentAt, fromBot: false },
    };
  }

  /**
   * The automatic harvest's view of the buffer (#340): per listening thread of
   * a binding with auto-harvest on (a group, or one forum topic of it), how
   * many messages were kept since both the switch and the last automatic
   * harvest's mark, and when the newest of them arrived. Only threads with
   * something new come back; whether one is due is `isThreadDue`'s to say.
   * `created_at` throughout, the server's clock, never Telegram's `sent_at`.
   * `newestAt` is rounded up to the millisecond: the column keeps microseconds
   * and a JS Date does not, so a mark at the truncated value would count the
   * newest message as new again, and read past it.
   */
  async listenedThreads(): Promise<ListenedThread[]> {
    return this.prisma.$queryRaw<ListenedThread[]>`
      SELECT m.binding_id AS "bindingId",
             COALESCE(m.topic_id, '') AS "topicKey",
             COUNT(*)::int AS "fresh",
             date_trunc('milliseconds', MAX(m.created_at)) + interval '1 millisecond' AS "newestAt",
             k.harvested_through AS "through"
        FROM chat_buffered_messages m
        JOIN chat_channel_bindings b ON b.id = m.binding_id
        JOIN chat_integrations i ON i.id = b.integration_id
        LEFT JOIN chat_harvest_marks k ON k.binding_id = m.binding_id AND k.topic_key = COALESCE(m.topic_id, '')
       WHERE b.listening AND b.auto_harvest_by IS NOT NULL AND i.enabled
         AND m.created_at > b.auto_harvest_at
         AND (k.harvested_through IS NULL OR m.created_at > k.harvested_through)
       GROUP BY m.binding_id, COALESCE(m.topic_id, ''), k.harvested_through`;
  }

  /**
   * What an automatic harvest of `thread` reads: the kept messages after its
   * mark (and the switch), up to the newest the sweep saw, oldest first and
   * capped like every other harvest (the first and the newest). The rows stay:
   * a group's buffer is only ever emptied by the TTL, listening off or /forget.
   */
  async listenedThread(thread: ListenedThread, after: Date, max: number): Promise<{ thread: ChatThread; firstMessageId: string | null }> {
    const where = {
      bindingId: thread.bindingId,
      topicId: thread.topicKey || null,
      createdAt: { gt: after, lte: thread.newestAt },
    };
    const select = { externalMessageId: true, authorId: true, text: true, sentAt: true } as const;
    let rows = (await this.prisma.chatBufferedMessage.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: max, select })).reverse();
    const truncated = thread.fresh > rows.length;
    if (truncated) {
      const first = await this.prisma.chatBufferedMessage.findFirst({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select });
      if (first) rows = [first, ...rows.slice(-(max - 1))];
    }
    return { thread: { messages: rows.map(toMessage), url: null, truncated }, firstMessageId: rows[0]?.externalMessageId ?? null };
  }

  /** Forwards a harvest has read: gone, so the next `/capture` starts from nothing. */
  async consume(ids: string[]): Promise<void> {
    if (ids.length) await this.prisma.chatBufferedMessage.deleteMany({ where: { id: { in: ids } } });
  }

  /** `/forget`: everything this bot keeps that the person wrote, and in a private chat, what they forwarded. */
  async forget(integrationId: string, inbound: ChatInbound): Promise<number> {
    const { count } = await this.prisma.chatBufferedMessage.deleteMany({
      where: {
        integrationId,
        OR: [
          { authorId: inbound.externalUserId },
          ...(inbound.isDm ? [{ externalChatId: inbound.chatId, bindingId: null }] : []),
        ],
      },
    });
    return count;
  }

  /** What has outlived its keep: a group's rows past the TTL, a DM's forwards past the window. */
  async purgeExpired(now = Date.now()): Promise<number> {
    const { count } = await this.prisma.chatBufferedMessage.deleteMany({
      where: {
        OR: [
          { bindingId: { not: null }, createdAt: { lt: new Date(now - this.ttlMs) } },
          { bindingId: null, createdAt: { lt: new Date(now - this.windowMs) } },
        ],
      },
    });
    return count;
  }

  private forwardsWhere(integrationId: string, chatId: string) {
    return { integrationId, externalChatId: chatId, bindingId: null, createdAt: { gt: new Date(Date.now() - this.windowMs) } };
  }
}

function toMessage(row: { authorId: string; text: string; sentAt: Date }): ChatThreadMessage {
  return { authorId: row.authorId, text: row.text, at: row.sentAt };
}
