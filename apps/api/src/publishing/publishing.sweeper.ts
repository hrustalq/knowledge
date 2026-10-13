import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SiteBuildProducer } from './site-build.producer.js';
import { SiteDomainsService } from './site-domains.service.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A pending domain is re-checked this often in its first day (people set DNS right after adding)… */
export const DOMAIN_CHECK_EARLY_MS = 5 * MINUTE;
/** …then hourly… */
export const DOMAIN_CHECK_LATE_MS = HOUR;
/** …and not at all after a week. Verify still checks on demand. */
export const DOMAIN_CHECK_GIVE_UP_MS = 7 * DAY;
/** Pending domains checked per tick: DNS is slow, and a tick must not outlast its interval. */
const DOMAIN_CHECKS_PER_TICK = 20;

/** A version still saying `building` this long after its last status write has lost its job. */
export const BUILD_STUCK_MS = 15 * MINUTE;
const STUCK_BUILDS_PER_TICK = 50;

/**
 * The publishing due checks (docs/features/44, issue #77 phase 2b), on one
 * fixed tick with back-pressure (CLAUDE.md: no cron in this repo):
 *
 * - **Pending domains.** Re-check the TXT record, often at first and then
 *   hourly, so a domain verifies itself once DNS propagates.
 * - **Lost builds.** A version that says `building` long after its last
 *   status write lost its job — to a Redis flush, or a worker that died
 *   between jobs. Requeue it. `SiteRebuildTrigger` does the same once at
 *   worker boot; this is the case where nothing restarted.
 *
 * API-side, like the other sweepers; each requeue is claimed with one guarded
 * update, so two API processes do not both enqueue a version.
 */
@Injectable()
export class PublishingSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublishingSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly domains: SiteDomainsService,
    private readonly builds: SiteBuildProducer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.config.get('PUBLISHING_SWEEP_INTERVAL_MS', { infer: true }));
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<{ domainsChecked: number; buildsRequeued: number }> {
    if (this.running) return { domainsChecked: 0, buildsRequeued: 0 };
    this.running = true;
    try {
      const domainsChecked = await this.checkPendingDomains(now).catch((e: unknown) => {
        this.logger.warn(`domain sweep failed: ${String(e)}`);
        return 0;
      });
      const buildsRequeued = await this.requeueStuckBuilds(now).catch((e: unknown) => {
        this.logger.warn(`stuck-build sweep failed: ${String(e)}`);
        return 0;
      });
      if (buildsRequeued > 0) this.logger.warn(`requeued ${buildsRequeued} site builds that lost their job`);
      return { domainsChecked, buildsRequeued };
    } finally {
      this.running = false;
    }
  }

  private async checkPendingDomains(now: Date): Promise<number> {
    if (!this.config.get('SITE_CUSTOM_DOMAINS', { infer: true })) return 0;
    const candidates = await this.prisma.siteDomain.findMany({
      where: {
        verifiedAt: null,
        createdAt: { gt: new Date(now.getTime() - DOMAIN_CHECK_GIVE_UP_MS) },
        OR: [{ lastCheckAt: null }, { lastCheckAt: { lt: new Date(now.getTime() - DOMAIN_CHECK_EARLY_MS) } }],
      },
      include: { site: true },
      orderBy: { lastCheckAt: { sort: 'asc', nulls: 'first' } },
      take: DOMAIN_CHECKS_PER_TICK * 3,
    });
    const due = candidates.filter((d) => isDomainCheckDue(d, now)).slice(0, DOMAIN_CHECKS_PER_TICK);
    for (const domain of due) await this.domains.check(domain);
    return due.length;
  }

  private async requeueStuckBuilds(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - BUILD_STUCK_MS);
    const stuck = await this.prisma.siteVersion.findMany({
      where: { status: 'building', updatedAt: { lt: cutoff } },
      select: { id: true },
      take: STUCK_BUILDS_PER_TICK,
    });
    let requeued = 0;
    for (const { id } of stuck) {
      // Restart the clock as the claim, so the next tick leaves it alone.
      const { count } = await this.prisma.siteVersion.updateMany({
        where: { id, status: 'building', updatedAt: { lt: cutoff } },
        data: { updatedAt: now },
      });
      if (count === 0) continue;
      await this.builds.enqueue(id, { now: true });
      requeued++;
    }
    return requeued;
  }
}

/** A pending domain is due when its last check is older than its age allows (never checked: due). */
export function isDomainCheckDue(domain: { createdAt: Date; lastCheckAt: Date | null; verifiedAt: Date | null }, now: Date): boolean {
  if (domain.verifiedAt) return false;
  const age = now.getTime() - domain.createdAt.getTime();
  if (age > DOMAIN_CHECK_GIVE_UP_MS) return false;
  if (!domain.lastCheckAt) return true;
  const interval = age < DAY ? DOMAIN_CHECK_EARLY_MS : DOMAIN_CHECK_LATE_MS;
  return now.getTime() - domain.lastCheckAt.getTime() >= interval;
}
