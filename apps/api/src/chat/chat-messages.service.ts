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

  /**
   * The team a searchable Time/Mattermost group is in, resolved once — at the
   * first message kept after it was bound or this shipped — so a search hit
   * links to its thread with no platform call at search time (#407). '' = in
   * no team. A failed lookup leaves it unresolved, for the next message.
   */
  async rememberTeam(binding: ChatChannelBinding, lookup: () => Promise<string | null>): Promise<void> {
    if (binding.teamName !== null) return;
    let team: string | null;
    try {
      team = await lookup();
    } catch {
      return;
    }
    // ponytail: resolved once; a renamed team keeps the old name until team_name is cleared
    await this.prisma.chatChannelBinding.updateMany({ where: { id: binding.id, teamName: null }, data: { teamName: team ?? '' } });
  }

  /**
   * An edit or a delete the platform reported. Only a message already kept is
   * touched. The row is locked and its chunk read under the lock, so a pack
   * committing at the same moment (`ChatIndexSweeper`) is either seen and
   * dropped here, or sees the new text and gives up.
   */
  async change(binding: ChatChannelBinding, inbound: ChatInbound): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ id: string; chunk_id: string | null }>>`
        SELECT id, chunk_id FROM chat_messages WHERE binding_id = ${binding.id}::uuid AND external_message_id = ${inbound.messageId} FOR UPDATE`;
      if (!row) return;
      if (row.chunk_id) await tx.chatChunk.deleteMany({ where: { id: row.chunk_id } });
      if (inbound.change === 'deleted') {
        await tx.chatMessage.delete({ where: { id: row.id } });
      } else {
        await tx.chatMessage.update({ where: { id: row.id }, data: { text: createMasker()(inbound.text), editedAt: inbound.at ?? new Date() } });
      }
    });
  }

  /**
   * `/forget`: everything this bot keeps for search that the person wrote, in
   * any of its groups. The rows go first and say which chunks held them as
   * they go, so a chunk packed while this waited on their lock goes too.
   */
  async forget(integrationId: string, authorId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const gone = await tx.$queryRaw<Array<{ chunk_id: string | null }>>`
        DELETE FROM chat_messages m USING chat_channel_bindings b
         WHERE b.id = m.binding_id AND b.integration_id = ${integrationId}::uuid AND m.author_id = ${authorId}
        RETURNING m.chunk_id`;
      const chunks = [...new Set(gone.flatMap((r) => (r.chunk_id ? [r.chunk_id] : [])))];
      if (chunks.length) await tx.chatChunk.deleteMany({ where: { id: { in: chunks } } });
      return gone.length;
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
