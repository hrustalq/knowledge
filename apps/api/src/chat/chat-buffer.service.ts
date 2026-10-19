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
  private readonly ttlDays: number;

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
        externalMessageId: { notIn: [m.messageId, inbound.messageId] },
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
