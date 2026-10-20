import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ChatChannelBinding } from '@prisma/client';
import type { ChatSearchSettings } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChatInbound } from './adapters/chat-adapter.types.js';
import { createMasker } from './harvest-mask.js';

/**
 * The messages of a searchable binding (#339) — every write to
 * `chat_messages` and `chat_chunks` goes through here.
 *
 * Masked on write with a fresh masker per message, as the harvest buffer is,
 * so raw text never reaches a row. This is not that buffer: its own switch,
 * its own retention, and a harvest never reads it.
 *
 * Changing a message (an edit, a delete, `/forget`) deletes the chunk that
 * held it, which detaches its siblings (`ON DELETE SET NULL`) for the indexer
 * to pack again. Postgres is the truth: a chunk's vector in ArcadeDB that
 * outlives its row is reaped by the indexer, and search joins the row, so it
 * is never served in between.
 */
@Injectable()
export class ChatMessagesService {
  readonly enabled: boolean;
  private readonly ceilingDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('CHAT_SEARCH_ENABLED', { infer: true });
    this.ceilingDays = config.get('CHAT_SEARCH_RETENTION_DAYS', { infer: true });
  }

  /** What the workspace asked for and what applies: never past the env ceiling. */
  async settings(workspaceId: string): Promise<ChatSearchSettings> {
    const row = await this.prisma.workspaceSettings.findUnique({
      where: { workspaceId },
      select: { chatSearchRetentionDays: true },
    });
    const requested = row?.chatSearchRetentionDays ?? null;
    return {
      available: this.enabled,
      retentionDays: { ceiling: this.ceilingDays, requested, applied: Math.min(requested ?? this.ceilingDays, this.ceilingDays) },
    };
  }

  async setRetention(workspaceId: string, days: number | null, actorId: string): Promise<ChatSearchSettings> {
    await this.prisma.workspaceSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, chatSearchRetentionDays: days, updatedBy: actorId },
      update: { chatSearchRetentionDays: days, updatedBy: actorId },
    });
    return this.settings(workspaceId);
  }

  /** A person's message in a searchable group. A redelivery is a no-op. */
  async keep(binding: ChatChannelBinding, inbound: ChatInbound): Promise<void> {
    await this.prisma.chatMessage.createMany({
      data: [
        {
          workspaceId: binding.workspaceId,
          bindingId: binding.id,
          threadKey: inbound.threadId ?? inbound.topicId ?? '',
          externalMessageId: inbound.messageId,
          authorId: inbound.externalUserId,
          text: createMasker()(inbound.text),
          sentAt: inbound.at ?? new Date(),
        },
      ],
      skipDuplicates: true,
    });
  }

  /** An edit or a delete the platform reported. Only a message already kept is touched. */
  async change(binding: ChatChannelBinding, inbound: ChatInbound): Promise<void> {
    const where = { bindingId: binding.id, externalMessageId: inbound.messageId };
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.chatMessage.findUnique({ where: { bindingId_externalMessageId: where }, select: { chunkId: true } });
      if (!row) return;
      if (row.chunkId) await tx.chatChunk.deleteMany({ where: { id: row.chunkId } });
      if (inbound.change === 'deleted') {
        await tx.chatMessage.deleteMany({ where });
      } else {
        await tx.chatMessage.updateMany({ where, data: { text: createMasker()(inbound.text), editedAt: inbound.at ?? new Date() } });
      }
    });
  }

  /** `/forget`: everything this bot keeps for search that the person wrote, in any of its groups. */
  async forget(integrationId: string, authorId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const where = { authorId, binding: { integrationId } };
      const held = await tx.chatMessage.findMany({ where: { ...where, chunkId: { not: null } }, select: { chunkId: true }, distinct: ['chunkId'] });
      if (held.length) await tx.chatChunk.deleteMany({ where: { id: { in: held.map((r) => r.chunkId!) } } });
      const { count } = await tx.chatMessage.deleteMany({ where });
      return count;
    });
  }

  /** Searching turned off: what was kept goes at once, not at the retention. */
  async purgeBinding(bindingId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.chatChunk.deleteMany({ where: { bindingId } }),
      this.prisma.chatMessage.deleteMany({ where: { bindingId } }),
    ]);
  }

  /**
   * Past each workspace's effective retention. A chunk goes whole once its
   * newest message is past it, and a message once it is past it and in no
   * chunk — so a window is never served half-expired, and a chunk's older
   * messages wait for its newest.
   */
  async purgeExpired(): Promise<number> {
    // `effective` of `settings()` spelled in SQL: the workspace's own days, never past the ceiling.
    const cutoff = (alias: string) => Prisma.sql`now() - make_interval(days => LEAST(COALESCE(
      (SELECT ws.chat_search_retention_days FROM workspace_settings ws WHERE ws.workspace_id = ${Prisma.raw(alias)}.workspace_id),
      ${this.ceilingDays}), ${this.ceilingDays})::int)`;
    const chunks = await this.prisma.$executeRaw`DELETE FROM chat_chunks c WHERE c.last_at < ${cutoff('c')}`;
    const messages = await this.prisma.$executeRaw`
      DELETE FROM chat_messages m WHERE m.chunk_id IS NULL AND m.sent_at < ${cutoff('m')}`;
    return chunks + messages;
  }
}
