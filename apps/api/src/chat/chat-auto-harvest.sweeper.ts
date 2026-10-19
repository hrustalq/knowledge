import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatChannelBinding, ChatIntegration } from '@prisma/client';
import type { ChatPlatformKind, Locale } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { withLocale } from '../i18n/t.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry.js';
import { ChatBufferService, type ListenedThread } from './chat-buffer.service.js';
import { autoHarvestLimits } from './chat-integrations.service.js';
import { HarvestRefused, HarvestService, type HarvestOutcome } from './harvest.service.js';

/** The quiet threshold is minutes; a minute's tick is precision enough. */
const SWEEP_INTERVAL_MS = 60_000;

export interface AutoHarvestThresholds {
  minMessages: number;
  quietMinutes: number;
  maxPerTick: number;
}

/** What became of one due thread. Each is its own reason so a spec can see it. */
export type AutoHarvestResult = 'harvested' | 'off' | 'owner' | 'claimed' | 'retry' | 'refused';

type BindingRow = ChatChannelBinding & { integration: ChatIntegration };

/**
 * The one due check (#340): a listening thread is harvested automatically once
 * it holds at least `minMessages` kept messages it was not harvested over, and
 * nothing has been kept for `quietMinutes` — a conversation that has stopped,
 * not one still going. A thread with nothing new since its mark never reaches
 * here: `listenedThreads` returns only threads with something new.
 */
export function isThreadDue(
  thread: Pick<ListenedThread, 'fresh' | 'newestAt'>,
  now: number,
  cfg: Pick<AutoHarvestThresholds, 'minMessages' | 'quietMinutes'>,
): boolean {
  return thread.fresh >= cfg.minMessages && thread.newestAt.getTime() <= now - cfg.quietMinutes * 60_000;
}

/**
 * The due threads this tick may harvest: the longest-quiet first, at most
 * `maxPerTick` per binding — the spend bound, one model call per harvest.
 * What is left is still due on the next tick.
 */
export function pickDue(threads: ListenedThread[], now: number, cfg: AutoHarvestThresholds): ListenedThread[] {
  const taken = new Map<string, number>();
  return threads
    .filter((t) => isThreadDue(t, now, cfg))
    .sort((a, b) => a.newestAt.getTime() - b.newestAt.getTime())
    .filter((t) => {
      const n = taken.get(t.bindingId) ?? 0;
      if (n >= cfg.maxPerTick) return false;
      taken.set(t.bindingId, n + 1);
      return true;
    });
}

/**
 * Automatic harvest of listening Telegram threads (#340). A binding a
 * workspace admin opted in has each quiet thread harvested as that admin —
 * the agent-trigger owner rule: whoever turned it on is who it runs as, never
 * a field anyone can name. Their role is re-checked on every harvest; a
 * demoted or removed admin's switch harvests nothing.
 *
 * API-side, a due check inside a fixed tick, never a second sweep while one
 * runs — there is no cron here. Every API process runs it: the mark on the
 * thread is moved by one guarded statement **before** the model is called, so
 * only one process harvests a thread. A refusal that will pass (the person's
 * hourly harvest rate, the AI budget) puts the mark back for the next tick;
 * any other outcome leaves it, so the thread is due again only once something
 * new is said in it.
 *
 * Nothing is posted in the group. Nobody there asked, and a bot that speaks
 * after every quiet hour is the bot talking to people who were not talking to
 * it. The group was told once, when the switch went on. The admin the
 * captures are attributed to gets an inbox row with the counts; the captures
 * themselves wait in the Captures inbox like any other.
 */
@Injectable()
export class ChatAutoHarvestSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatAutoHarvestSweeper.name);
  private readonly available: boolean;
  private readonly cfg: AutoHarvestThresholds;
  private readonly harvestMax: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly buffer: ChatBufferService,
    private readonly harvester: HarvestService,
    private readonly access: AccessService,
    private readonly registry: ChatAdapterRegistry,
    private readonly notifications: NotificationsService,
    private readonly events: EventsPublisher,
    config: ConfigService<Env, true>,
  ) {
    const limits = autoHarvestLimits(config);
    this.available = limits.available;
    this.cfg = { ...limits, maxPerTick: config.get('HARVEST_AUTO_MAX_PER_TICK', { infer: true }) };
    this.harvestMax = config.get('HARVEST_MAX_MESSAGES', { infer: true });
  }

  onModuleInit(): void {
    if (!this.available || this.cfg.maxPerTick < 1) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One tick: the due threads, each harvested at most once. Returns how many were. */
  async sweep(now = Date.now()): Promise<number> {
    if (this.running) return 0; // a tick of model calls must not stack on itself
    this.running = true;
    try {
      const due = pickDue(await this.buffer.listenedThreads(), now, this.cfg);
      if (!due.length) return 0;
      const bindings = new Map(
        (
          await this.prisma.chatChannelBinding.findMany({
            where: { id: { in: [...new Set(due.map((t) => t.bindingId))] } },
            include: { integration: true },
          })
        ).map((b) => [b.id, b]),
      );
      let harvested = 0;
      for (const thread of due) {
        const binding = bindings.get(thread.bindingId);
        if (binding && (await this.harvestThread(thread, binding)) === 'harvested') harvested++;
      }
      if (harvested) this.logger.log(`harvested ${harvested} listening chat threads`);
      return harvested;
    } catch (e: unknown) {
      this.logger.warn(`chat auto-harvest sweep failed: ${String(e)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  async harvestThread(thread: ListenedThread, binding: BindingRow): Promise<AutoHarvestResult> {
    const owner = binding.autoHarvestBy;
    // Switched off, or listening off, since the sweep read the buffer.
    if (!owner || !binding.autoHarvestAt || !binding.listening) return 'off';
    const locale = (binding.locale ?? binding.integration.locale) as Locale;
    let principal: Principal;
    try {
      // On execution, not on offer: the switch outlives a change of role.
      principal = await this.access.principalFor(owner, locale);
      await this.access.requireRole(principal, binding.workspaceId, 'admin');
    } catch {
      this.logger.debug({ msg: 'auto-harvest owner may no longer run it', bindingId: binding.id });
      return 'owner';
    }
    if (!(await this.claim(thread))) return 'claimed';
    const after = new Date(Math.max(thread.through?.getTime() ?? 0, binding.autoHarvestAt.getTime()));
    try {
      const outcome = await withLocale(locale, async () => {
        const read = await this.buffer.listenedThread(thread, after, this.harvestMax);
        const adapter = this.registry.get(binding.integration.kind);
        const url = read.firstMessageId ? (adapter.messageUrl?.(binding.externalChatId, read.firstMessageId) ?? null) : null;
        return this.harvester.harvest(
          {
            workspaceId: binding.workspaceId,
            projectId: binding.projectId,
            platform: binding.integration.kind as ChatPlatformKind,
            chatTitle: binding.title,
            thread: { ...read.thread, url },
          },
          principal,
        );
      });
      if (outcome.proposed) await this.tell(binding, owner, outcome);
      return 'harvested';
    } catch (err) {
      if (passes(err)) {
        await this.release(thread);
        return 'retry';
      }
      this.logger.warn({ msg: 'chat auto-harvest refused', bindingId: binding.id, error: String(err) });
      return 'refused';
    }
  }

  /**
   * Move the thread's mark to the newest message this tick saw, from where it
   * was read — one guarded statement, so a second API process loses. A thread
   * never harvested has no row yet, and the insert's unique key decides.
   */
  private async claim(thread: ListenedThread): Promise<boolean> {
    const key = { bindingId: thread.bindingId, topicKey: thread.topicKey };
    if (!thread.through) {
      const { count } = await this.prisma.chatHarvestMark.createMany({
        data: [{ ...key, harvestedThrough: thread.newestAt }],
        skipDuplicates: true,
      });
      return count === 1;
    }
    const { count } = await this.prisma.chatHarvestMark.updateMany({
      where: { ...key, harvestedThrough: thread.through },
      data: { harvestedThrough: thread.newestAt, harvestedAt: new Date() },
    });
    return count === 1;
  }

  /** Put the mark back (guarded again), so the next tick tries the same thread. */
  private async release(thread: ListenedThread): Promise<void> {
    const where = { bindingId: thread.bindingId, topicKey: thread.topicKey, harvestedThrough: thread.newestAt };
    if (!thread.through) await this.prisma.chatHarvestMark.deleteMany({ where });
    else await this.prisma.chatHarvestMark.updateMany({ where, data: { harvestedThrough: thread.through } });
  }

  /**
   * The admin it ran as hears that something waits on review: counts and the
   * group's name, which they set up. Never a capture's title — the inbox row
   * links to the Captures inbox, which shows those under its own rules.
   */
  private async tell(binding: BindingRow, owner: string, outcome: HarvestOutcome): Promise<void> {
    const delivered = await this.notifications.notify({
      workspaceId: binding.workspaceId,
      userIds: [owner],
      type: 'chat.harvest.proposed',
      reason: 'participant',
      actor: null,
      title: binding.title ?? binding.externalChatId,
      metadata: { bindingId: binding.id, proposed: outcome.proposed, duplicates: outcome.duplicates },
    });
    await this.events.announce(binding.workspaceId, delivered);
  }
}

/** A refusal that will pass by itself: the person's hourly harvest rate, the AI budget. */
function passes(err: unknown): boolean {
  if (err instanceof HarvestRefused) return err.key === 'chat.harvest.rateLimited';
  return err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS;
}
