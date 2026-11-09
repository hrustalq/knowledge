import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@nestjs/common';
import { Ticker } from '../src/common/ticker.js';

/** #820: the one interval + back-pressure + non-fatal catch every sweeper uses. */
describe('Ticker', () => {
  const warn = vi.fn();
  const logger = { warn } as unknown as Logger;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    warn.mockReset();
  });

  it('never overlaps: a tick that outlasts the interval makes the next ones no-ops', async () => {
    const ticker = new Ticker(logger);
    let release!: () => void;
    let started = 0;
    const sweep = () =>
      ticker.exclusive(async () => {
        started += 1;
        await new Promise<void>((r) => (release = r));
      });
    ticker.every(1_000, sweep);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000); // five more ticks while the first is in flight
    expect(started).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(2);
    ticker.stop();
  });

  it('returns idle while busy, the result otherwise, and idle after a logged failure', async () => {
    const ticker = new Ticker(logger);
    let release!: () => void;
    const first = ticker.exclusive(() => new Promise<number>((r) => (release = () => r(7))), 0);
    expect(await ticker.exclusive(async () => 99, 0)).toBe(0);
    release();
    expect(await first).toBe(7);

    expect(
      await ticker.exclusive(async () => {
        throw new Error('db down');
      }, -1),
    ).toBe(-1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    expect(await ticker.exclusive(async () => 3, 0)).toBe(3); // the flag was released
  });

  it('stops: no tick after stop()', async () => {
    const ticker = new Ticker(logger);
    const fn = vi.fn();
    ticker.every(1_000, fn);
    await vi.advanceTimersByTimeAsync(1_000);
    ticker.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
