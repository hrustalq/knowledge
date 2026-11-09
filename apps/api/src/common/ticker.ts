import type { Logger } from '@nestjs/common';

/**
 * The one fixed tick (#820). There is no cron in this repo: scheduled work is
 * a due check inside a fixed interval, with back-pressure, so a slow pass
 * never stacks a second one on top of itself.
 *
 * `every` owns the interval, `stop` the shutdown, and `exclusive` the
 * back-pressure and the non-fatal catch. A sweeper keeps its public `sweep()`
 * (specs call it directly) and wraps its body in `exclusive`, so a direct call
 * and a timer call share the same in-flight flag.
 */
export class Ticker {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly logger: Logger) {}

  /**
   * Calls `fn` every `ms`. The timer is unref'd, so it never holds a process
   * open — unless `keepAlive`, for a process whose only work is this tick.
   */
  every(ms: number, fn: () => unknown, { keepAlive = false } = {}): void {
    this.timer = setInterval(() => void fn(), ms);
    if (!keepAlive) this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Runs `fn` unless a pass is in flight. A busy or failed pass returns `idle`; a failure is logged, never thrown. */
  exclusive(fn: () => Promise<void>): Promise<void>;
  exclusive<T>(fn: () => Promise<T>, idle: T): Promise<T>;
  async exclusive<T>(fn: () => Promise<T>, idle?: T): Promise<T | undefined> {
    if (this.busy) return idle;
    this.busy = true;
    try {
      return await fn();
    } catch (error) {
      this.logger.warn(`tick failed (non-fatal): ${(error as Error)?.message ?? String(error)}`);
      return idle;
    } finally {
      this.busy = false;
    }
  }
}
