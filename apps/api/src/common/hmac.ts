import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Whether `sentHex` is the HMAC-SHA256 of `payload` under `secret`.
 *
 * The one comparison every inbound signature check makes — GitHub's
 * `X-Hub-Signature-256` (docs/features/19, 35) and an agent trigger's
 * `X-Knowledge-Signature` (#70). It compares decoded bytes in constant time
 * rather than strings: a check that returns at the first wrong character leaks
 * the expected value a byte at a time. A malformed or empty signature is
 * simply false, never a throw — `timingSafeEqual` throws on a length mismatch,
 * which is why the length is checked first.
 */
export function verifyHmacSha256(payload: string, secret: string, sentHex: string): boolean {
  const sent = sentHex.trim().replace(/^sha256=/, '');
  if (!sent || !/^[0-9a-f]+$/i.test(sent)) return false;
  const a = Buffer.from(sent, 'hex');
  const b = createHmac('sha256', secret).update(payload, 'utf8').digest();
  return a.length === b.length && timingSafeEqual(a, b);
}
