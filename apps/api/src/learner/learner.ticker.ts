import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { LearnerService } from './learner.service.js';

/** How often a workspace is passed over, at most. */
export const LEARNER_PASS_INTERVAL_MS = 86_400_000;

export type TickOutcome =
  /** LEARNER_ENABLED is off: nothing read, nothing written. */
  | 'disabled'
  /** A pass was still in flight; this tick started nothing. */
  | 'busy'
  /** Every due workspace was passed over (possibly none). */
  | { passed: number };

/**
 * The learner's clock (#305). There is no cron in this repo: a fixed tick
 * every LEARNER_TICK_MS, a per-workspace daily due check inside it, and
 * back-pressure — a tick that finds a pass still running starts nothing, so a
 * slow model or a large workspace can never stack passes on top of each other.
 *
 * The due check is in memory. A restart makes every workspace due once more,
 * which costs at most the coach calls for clusters it declined last time: a
 * pass is idempotent otherwise (a cluster already in a learning's evidence
 * folds, an archived one is skipped, a flagged learning is not flagged again).
 */
@Injectable()
export class LearnerTicker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LearnerTicker.name);
  private readonly enabled: boolean;
  private readonly tickMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<TickOutcome> | null = null;
  /** When each workspace's last pass started. */
  private readonly lastPass = new Map<string, number>();

  constructor(
    private readonly learner: LearnerService,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('LEARNER_ENABLED', { infer: true });
    this.tickMs = config.get('LEARNER_TICK_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    // The timer runs either way: it is what keeps this process alive, so a
    // disabled learner idles (each tick returns at once) instead of exiting
    // and being restarted by its container in a loop.
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    if (!this.enabled) {
      this.logger.log('Learner disabled (LEARNER_ENABLED=false): idle');
      return;
    }
    void this.tick();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One tick. Never throws: a failing workspace is logged and retried at its next due time. */
  tick(now: () => number = Date.now): Promise<TickOutcome> {
    if (!this.enabled) return Promise.resolve('disabled');
    if (this.inFlight) return Promise.resolve('busy');
    const run = this.passDue(now).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async passDue(now: () => number): Promise<TickOutcome> {
    let passed = 0;
    let ids: string[];
    try {
      ids = await this.learner.workspaceIds();
    } catch (error) {
      this.logger.warn({ msg: 'learner could not list workspaces', error: String(error) });
      return { passed };
    }
    for (const workspaceId of ids) {
      const last = this.lastPass.get(workspaceId);
      if (last !== undefined && now() - last < LEARNER_PASS_INTERVAL_MS) continue;
      // Marked before the pass: a workspace that fails is not retried every tick.
      this.lastPass.set(workspaceId, now());
      try {
        await this.learner.pass(workspaceId, new Date(now()));
        passed += 1;
      } catch (error) {
        this.logger.warn({ msg: 'learner pass failed', workspaceId, error: String(error) });
      }
    }
    return { passed };
  }
}
