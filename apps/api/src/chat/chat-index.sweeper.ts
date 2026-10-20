import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService } from '../graph/graph.service.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { sealedWindows, windowText, type UnpackedMessage, type WindowRules } from './chat-windows.js';

/** Threads packed per tick, at most: a backlog drains over several ticks, one embedding call per thread. */
const THREADS_PER_TICK = 50;
/** Unpacked messages read per thread per tick; the rest wait for the next. */
const MESSAGES_PER_THREAD = 500;
/** Ticks between reaps of vectors whose row is gone. */
const REAP_EVERY_TICKS = 10;
/** A vector younger than this may belong to a pack still committing (in another worker), so the reap leaves it. */
const REAP_GRACE_MS = 5 * 60_000;
/** Chunk ids looked up in PG per query during the reap. */
const REAP_PAGE = 1000;

/**
 * The chat search indexer (#339, phase 2): worker-only, a fixed tick with
 * back-pressure — there is no cron here.
 *
 * Each tick packs the threads of searchable groups whose unpacked messages
 * are ready (`sealedWindows`): one window becomes one `chat_chunks` row and
 * one `ChatChunk` vector. The vector is written first and the row second, in
 * a transaction that locks the window's messages and checks they are still
 * unpacked and unchanged. An edit, a delete or `/forget` that got there first
 * makes the pack give up (the window is read again next tick); one that comes
 * after finds the chunk under its lock and drops it (`ChatMessagesService`).
 *
 * PG is the truth. A vector whose row never committed, or whose row an edit,
 * a retention sweep, `/forget`, a switch-off or an unbind deleted since, is an
 * orphan no search returns — search joins the row — and the reap removes it
 * every `REAP_EVERY_TICKS` ticks.
 */
@Injectable()
export class ChatIndexSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatIndexSweeper.name);
  private readonly rules: WindowRules;
  private readonly tickMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private ticks = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    config: ConfigService<Env, true>,
  ) {
    this.rules = {
      maxMessages: config.get('CHAT_SEARCH_WINDOW_MESSAGES', { infer: true }),
      gapMs: config.get('CHAT_SEARCH_WINDOW_GAP_MIN', { infer: true }) * 60_000,
      settleMs: config.get('CHAT_SEARCH_SETTLE_MIN', { infer: true }) * 60_000,
    };
    this.tickMs = config.get('CHAT_SEARCH_TICK_SEC', { infer: true }) * 1000;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.tickMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One tick. Returns the windows packed. */
  async sweep(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const packed = await this.index(now);
      this.ticks += 1;
      if (this.ticks % REAP_EVERY_TICKS === 0) await this.reap(now);
      return packed;
    } catch (e) {
      this.logger.warn(`Chat index sweep failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async index(now: number): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ binding_id: string; thread_key: string }>>`
      SELECT m.binding_id, m.thread_key FROM chat_messages m
        JOIN chat_channel_bindings b ON b.id = m.binding_id AND b.searchable_at IS NOT NULL
       WHERE m.chunk_id IS NULL
       GROUP BY m.binding_id, m.thread_key
      HAVING max(m.sent_at) < ${new Date(now - this.rules.settleMs)} OR count(*) >= ${this.rules.maxMessages}
       ORDER BY min(m.sent_at)
       LIMIT ${THREADS_PER_TICK}`;
    let packed = 0;
    for (const thread of due) {
      try {
        packed += await this.packThread(thread.binding_id, thread.thread_key, now);
      } catch (e) {
        this.logger.warn(`Chat thread not indexed (binding ${thread.binding_id}); retrying next tick: ${(e as Error).message}`);
      }
    }
    if (packed) this.logger.log(`Chat search: indexed ${packed} windows`);
    return packed;
  }

  private async packThread(bindingId: string, threadKey: string, now: number): Promise<number> {
    const binding = await this.prisma.chatChannelBinding.findUnique({ where: { id: bindingId }, select: { workspaceId: true, title: true } });
    if (!binding) return 0;
    const messages = await this.prisma.chatMessage.findMany({
      where: { bindingId, threadKey, chunkId: null },
      orderBy: { sentAt: 'asc' },
      take: MESSAGES_PER_THREAD,
      select: { id: true, authorId: true, text: true, sentAt: true },
    });
    const windows = sealedWindows(messages, this.rules, now);
    if (!windows.length) return 0;
    const texts = windows.map(windowText);
    // The group's title rides along in the vector, never in the stored text.
    const vectors = await this.embeddings.embedBatch(texts.map((t) => (binding.title ? `${binding.title}\n${t}` : t)));
    let packed = 0;
    for (const [i, window] of windows.entries()) {
      if (await this.pack({ workspaceId: binding.workspaceId, bindingId, threadKey }, window, texts[i], vectors[i], now)) packed += 1;
    }
    return packed;
  }

  private async pack(
    at: { workspaceId: string; bindingId: string; threadKey: string },
    window: UnpackedMessage[],
    text: string,
    embedding: number[],
    now: number,
  ): Promise<boolean> {
    const chunkId = randomUUID();
    const ids = window.map((m) => m.id);
    await this.graph.upsertChatChunk({ workspaceId: at.workspaceId, bindingId: at.bindingId, chunkId, embedding, writtenAt: now });
    const committed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; text: string }>>`
        SELECT id, text FROM chat_messages WHERE id = ANY(${ids}::uuid[]) AND chunk_id IS NULL FOR UPDATE`;
      const current = new Map(rows.map((r) => [r.id, r.text]));
      if (window.some((m) => current.get(m.id) !== m.text)) return false;
      await tx.chatChunk.create({
        data: {
          id: chunkId,
          ...at,
          text,
          firstAt: window[0].sentAt,
          lastAt: window.at(-1)!.sentAt,
          messageCount: window.length,
        },
      });
      await tx.chatMessage.updateMany({ where: { id: { in: ids } }, data: { chunkId } });
      return true;
    });
    if (!committed) await this.graph.deleteChatChunks(at.workspaceId, [chunkId]);
    return committed;
  }

  /** Vectors whose row is gone, workspace by workspace. */
  private async reap(now: number): Promise<void> {
    const workspaces = await this.prisma.workspace.findMany({ select: { id: true } });
    let reaped = 0;
    for (const { id: workspaceId } of workspaces) {
      // ponytail: reads every vector id of the workspace each reap; page it by writtenAt if chat volume makes that slow
      const vectors = (await this.graph.chatChunkIds(workspaceId)).filter((v) => now - v.writtenAt > REAP_GRACE_MS).map((v) => v.chunkId);
      for (let i = 0; i < vectors.length; i += REAP_PAGE) {
        const page = vectors.slice(i, i + REAP_PAGE);
        const kept = new Set((await this.prisma.chatChunk.findMany({ where: { id: { in: page } }, select: { id: true } })).map((r) => r.id));
        const orphans = page.filter((id) => !kept.has(id));
        await this.graph.deleteChatChunks(workspaceId, orphans);
        reaped += orphans.length;
      }
    }
    if (reaped) this.logger.log(`Chat search: reaped ${reaped} orphaned vectors`);
  }
}
