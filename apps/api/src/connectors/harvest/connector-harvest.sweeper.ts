import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connector, ConnectorHarvest } from '@prisma/client';
import { DEFAULT_HARVEST_LABEL, type ConnectorKind, type Locale } from '@knowledge/contracts';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService } from '../../auth/access.service.js';
import type { Principal } from '../../auth/principal.js';
import { EventsPublisher } from '../../events/events.publisher.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { HarvestRefused, HarvestService } from '../../chat/harvest.service.js';
import { ConnectorsService } from '../connectors.service.js';
import { ConnectorAclService } from '../connector-acl.service.js';
import type { HarvestDelivery, HarvestItem } from '../adapters/connector.types.js';

const SWEEP_INTERVAL_MS = 30_000;
/** Claimed rows finished per tick: one model call each. */
const PER_TICK = 5;
/** A lease: a row a crashed process was working on is picked up again after this. */
const LEASE_MS = 10 * 60_000;

/** What became of one claimed item. Each is its own reason so a spec can see it. */
export type ConnectorHarvestResult = 'harvested' | 'released' | 'retry' | 'leased';

/** `config.harvestLabel`, else `knowledge`; compared case-insensitively. */
export function harvestLabelFor(row: Pick<Connector, 'config'>): string {
  const label = (row.config as { harvestLabel?: unknown } | null)?.harvestLabel;
  return (typeof label === 'string' && label.trim() ? label.trim() : DEFAULT_HARVEST_LABEL).toLowerCase();
}

/** Whether a fresh read of the item still qualifies: resolved, labelled, and something was said. */
export function qualifies(item: HarvestItem | null, label: string): item is HarvestItem {
  return !!item && item.resolved && item.messages.length > 0 && item.labels.some((l) => l.toLowerCase() === label);
}

/** The first message and the newest replies, at most `max` — what chat's `fetchThread` keeps. */
export function capMessages<T>(messages: T[], max: number): { kept: T[]; truncated: boolean } {
  if (messages.length <= max) return { kept: messages, truncated: false };
  return { kept: [messages[0]!, ...messages.slice(messages.length - (max - 1))], truncated: true };
}

/**
 * Harvest connectors (#382, doc 59): a resolved, labelled tracker or help-desk
 * item becomes reviewed captures, in the name of whoever resolved it.
 *
 * Two halves, the connector webhook's and a fixed tick's — there is no cron.
 * {@link claim} runs in the webhook: it records who resolved the item and
 * inserts one `connector_harvests` row per (connector, item), the insert being
 * the once-per-item rule. {@link sweep} finishes claimed rows: the person
 * must map to a member who is an editor *now*, the item is read fresh and
 * must still be resolved and labelled, and only then is `HarvestService` asked,
 * as that person. A row that does not qualify is deleted, so a later
 * qualifying delivery can claim the item again; a harvested row stays.
 *
 * API-side only (ConnectorsModule, never a module MCP or the worker imports):
 * a capture is attributed to a person, and the API is where a principal
 * exists. The row's lease is what makes two API processes take turns.
 * Nothing is written on the ticket; the person hears in their inbox.
 */
@Injectable()
export class ConnectorHarvestSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectorHarvestSweeper.name);
  private readonly enabled: boolean;
  private readonly harvestMax: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly acl: ConnectorAclService,
    private readonly access: AccessService,
    private readonly harvester: HarvestService,
    private readonly notifications: NotificationsService,
    private readonly events: EventsPublisher,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('HARVEST_ENABLED', { infer: true });
    this.harvestMax = config.get('HARVEST_MAX_MESSAGES', { infer: true });
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * A verified delivery's resolution: who did it is recorded (their email is
   * only on the delivery), and the item is claimed unless it already is.
   * Answers whether this call claimed it. No model call, no fetch.
   */
  async claim(row: Connector, item: NonNullable<HarvestDelivery['item']>): Promise<boolean> {
    if (!this.enabled) return false;
    await this.acl.userFor(row, item.actor);
    const created = await this.prisma.connectorHarvest.createMany({
      data: [{ workspaceId: row.workspaceId, connectorId: row.id, externalId: item.externalId, actorId: item.actor.externalId }],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  /** One tick: the oldest claimed rows, each finished at most once. Returns how many were harvested. */
  async sweep(now = Date.now()): Promise<number> {
    if (this.running) return 0; // a tick of model calls must not stack on itself
    this.running = true;
    try {
      const due = await this.prisma.connectorHarvest.findMany({
        where: { harvestedAt: null, OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now - LEASE_MS) } }] },
        orderBy: { createdAt: 'asc' },
        take: PER_TICK,
        include: { connector: true },
      });
      let harvested = 0;
      for (const row of due) if ((await this.finish(row, now)) === 'harvested') harvested++;
      if (harvested) this.logger.log(`harvested ${harvested} resolved connector items`);
      return harvested;
    } catch (e: unknown) {
      this.logger.warn(`connector harvest sweep failed: ${String(e)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  async finish(row: ConnectorHarvest & { connector: Connector }, now = Date.now()): Promise<ConnectorHarvestResult> {
    // The lease, one guarded statement: a second process finds it taken.
    const leased = await this.prisma.connectorHarvest.updateMany({
      where: { id: row.id, harvestedAt: null, lockedAt: row.lockedAt },
      data: { lockedAt: new Date(now) },
    });
    if (leased.count === 0) return 'leased';
    const connector = row.connector;
    const adapter = this.connectors.adapterFor(connector);
    if (!connector.enabled || !adapter.readHarvestItem) return this.release(row);

    const identity = await this.prisma.externalIdentity.findUnique({
      where: { connectorId_externalId: { connectorId: connector.id, externalId: row.actorId } },
      select: { userId: true },
    });
    if (!identity?.userId) return this.release(row);
    let principal: Principal;
    try {
      // On execution, not on offer: a role can change between the close and this tick.
      const user = await this.prisma.user.findUnique({ where: { id: identity.userId }, select: { locale: true } });
      principal = await this.access.principalFor(identity.userId, (user?.locale ?? 'en') as Locale);
      await this.access.requireRole(principal, connector.workspaceId, 'editor');
    } catch {
      return this.release(row);
    }

    try {
      const ctx = await this.connectors.contextFor(connector, async () => undefined);
      const item = await adapter.readHarvestItem(ctx, row.externalId);
      if (!qualifies(item, harvestLabelFor(connector))) return this.release(row);
      const { kept, truncated } = capMessages(item.messages, this.harvestMax);
      const outcome = await this.harvester.harvest(
        {
          workspaceId: connector.workspaceId,
          projectId: connector.projectId,
          platform: connector.kind as ConnectorKind,
          chatTitle: `${item.key} · ${item.title}`.slice(0, 200),
          thread: { messages: kept, url: item.url || null, truncated },
        },
        principal,
      );
      await this.prisma.connectorHarvest.update({
        where: { id: row.id },
        data: { harvestedAt: new Date(), userId: principal.userId, proposed: outcome.proposed, duplicates: outcome.duplicates },
      });
      if (outcome.proposed) await this.tell(connector, principal.userId, item, outcome);
      return 'harvested';
    } catch (err) {
      if (passes(err)) {
        await this.prisma.connectorHarvest.updateMany({ where: { id: row.id, harvestedAt: null }, data: { lockedAt: null } });
        return 'retry';
      }
      // Captures off, the harvester off, the source refusing: nothing to retry
      // on a timer, and a later resolution may claim the item again.
      this.logger.warn({ msg: 'connector harvest refused', connectorId: connector.id, error: String(err) });
      return this.release(row);
    }
  }

  private async release(row: ConnectorHarvest): Promise<'released'> {
    await this.prisma.connectorHarvest.deleteMany({ where: { id: row.id, harvestedAt: null } });
    return 'released';
  }

  /** Counts and the item's key and title, which the person resolved; never a capture's title. */
  private async tell(connector: Connector, userId: string, item: HarvestItem, outcome: { proposed: number; duplicates: number }): Promise<void> {
    const delivered = await this.notifications.notify({
      workspaceId: connector.workspaceId,
      userIds: [userId],
      type: 'connector.harvest.proposed',
      reason: 'participant',
      actor: null,
      title: `${item.key} · ${item.title}`.slice(0, 200),
      metadata: { connectorId: connector.id, proposed: outcome.proposed, duplicates: outcome.duplicates },
    });
    await this.events.announce(connector.workspaceId, delivered);
  }
}

/** A refusal that will pass by itself: the person's hourly harvest rate, the AI budget. */
function passes(err: unknown): boolean {
  if (err instanceof HarvestRefused) return err.key === 'chat.harvest.rateLimited';
  return err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS;
}
