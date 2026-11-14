import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PublicStore } from '../public/public-store.js';

/**
 * How long a delivery's body is remembered (#1143). GitHub and the repo hooks
 * sign the body but stamp no time into it, so a captured delivery verifies
 * forever; this is the window in which replaying one does nothing.
 */
// ponytail: a 90-day memory, not forever; a PG table of seen hashes if a replay older than that ever matters.
const SEEN_MS = 90 * 24 * 3_600_000;

/**
 * Each signed delivery is acted on once (#1143). A replayed issue, pull-request
 * or push delivery is not harmless: it re-publishes the `repo.*` event (an
 * agent trigger past its cooldown starts another paid run), writes an old
 * ticket state over a newer one, and queues a drift check for a head the pull
 * request has moved past. `X-GitHub-Delivery` is not signed, so the key is a
 * hash of the body the signature covers — a genuine redelivery is the same
 * body too, and is equally already handled.
 *
 * The key is claimed before the handler runs, so two concurrent copies cannot
 * both pass, and released when the handler throws (a bad signature included),
 * so an unsigned guess holds nothing and a real delivery that failed can be
 * redelivered. A Redis outage passes every delivery: losing a real one is
 * worse than a replay that needs a captured body and the outage to coincide.
 */
@Injectable()
export class WebhookReplay {
  private readonly logger = new Logger(WebhookReplay.name);

  constructor(private readonly store: PublicStore) {}

  /** Run `handle` unless this exact body already reached `scope`; `seen` otherwise. */
  async once<T>(scope: string, rawBody: string, seen: T, handle: () => Promise<T>): Promise<T> {
    const key = `kn:wh:${scope}:${createHash('sha256').update(rawBody).digest('hex')}`;
    let claimed: boolean;
    try {
      claimed = (await this.store.kv.set(key, '1', 'PX', SEEN_MS, 'NX')) !== null;
    } catch (err) {
      this.logger.warn({ msg: 'webhook replay check unavailable', scope, err });
      return handle();
    }
    if (!claimed) return seen;
    try {
      return await handle();
    } catch (err) {
      await this.store.kv.del(key).catch(() => undefined);
      throw err;
    }
  }
}
