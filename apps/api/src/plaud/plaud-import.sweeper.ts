import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { PlaudLink } from '@prisma/client';
import { AccessService } from '../auth/access.service.js';
import { Ticker } from '../common/ticker.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { asLocale } from '../i18n/locale.js';
import { withLocale } from '../i18n/t.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlaudImportsService } from './plaud-imports.service.js';
import { PlaudOauthService } from './plaud-oauth.service.js';

const SWEEP_INTERVAL_MS = 60_000;
/** How often one person's Plaud account is looked at. */
const CHECK_EVERY_MS = 10 * 60_000;
const BATCH = 5;

/**
 * Plaud auto-import's tick (#864), API-only: an import is the person's act
 * and opens their memo, so it runs where their principal can be rebuilt and
 * their editor role checked now, not when they saved their settings.
 *
 * Each due link is claimed by moving `checked_at` in one guarded statement,
 * so two API processes never sweep one account at once. Asking for the token
 * on every pass is also what keeps the sign-in alive: Plaud drops one that
 * goes seven days without a refresh, including for a person whose auto-import
 * is switched off.
 */
@Injectable()
export class PlaudImportSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaudImportSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: PlaudOauthService,
    private readonly imports: PlaudImportsService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly events: EventsPublisher,
  ) {}

  onModuleInit(): void {
    if (this.oauth.configured) this.ticker.every(SWEEP_INTERVAL_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  async sweep(now = new Date()): Promise<void> {
    return this.ticker.exclusive(async () => {
      const stale = new Date(now.getTime() - CHECK_EVERY_MS);
      const due = await this.prisma.plaudLink.findMany({
        where: { OR: [{ checkedAt: null }, { checkedAt: { lt: stale } }] },
        orderBy: { checkedAt: { sort: 'asc', nulls: 'first' } },
        take: BATCH,
      });
      for (const link of due) {
        const claimed = await this.prisma.plaudLink.updateMany({
          where: { id: link.id, OR: [{ checkedAt: null }, { checkedAt: { lt: stale } }] },
          data: { checkedAt: now },
        });
        if (claimed.count === 0) continue;
        await withLocale(asLocale(link.locale), () => this.check(link, now)).catch((error: unknown) =>
          this.logger.warn(`Plaud link ${link.id} was not checked: ${(error as Error).message}`),
        );
      }
    });
  }

  private async check(link: PlaudLink, now: Date): Promise<void> {
    // A workspace being deleted imports nothing; its rows go with it.
    const workspace = await this.prisma.workspace.findFirst({ where: { id: link.workspaceId, deletedAt: null }, select: { id: true } });
    if (!workspace) return;

    // Also the keep-alive: this refreshes a token about to expire.
    let linked = Boolean(await this.oauth.tokenFor(link.userId));
    if (linked && link.projectId) {
      const principal = await this.access.principalFor(link.userId, asLocale(link.locale));
      // Checked on execution: a person demoted since saving their settings imports nothing.
      await this.access.requireRole(principal, link.workspaceId, 'editor');
      const result = await this.imports.sweepLink(principal, link, now);
      linked = result.linked;
      if (result.pending > 0) await this.tell(link, 'plaud.pending', { pending: result.pending });
    }

    if (linked) {
      if (link.reconnectNotifiedAt) await this.prisma.plaudLink.update({ where: { id: link.id }, data: { reconnectNotifiedAt: null } });
      return;
    }
    // Lapsed or unlinked at Plaud: said once, then silent until they link again.
    const first = await this.prisma.plaudLink.updateMany({ where: { id: link.id, reconnectNotifiedAt: null }, data: { reconnectNotifiedAt: now } });
    if (first.count === 1 && (await this.oauth.status(link.userId)).linked) await this.tell(link, 'plaud.reconnect', {});
  }

  /** The account's owner alone, with a count and never a recording's name. */
  private async tell(link: PlaudLink, type: 'plaud.pending' | 'plaud.reconnect', counts: Record<string, number>): Promise<void> {
    const delivered = await this.notifications.notify({
      workspaceId: link.workspaceId,
      userIds: [link.userId],
      type,
      reason: 'author',
      actor: null,
      title: 'Plaud',
      metadata: counts,
    });
    await this.events.announce(link.workspaceId, delivered);
  }
}
