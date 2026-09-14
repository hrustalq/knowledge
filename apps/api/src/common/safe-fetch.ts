import { Agent, type Dispatcher } from 'undici';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isPrivateAddress } from './safe-url.js';

/**
 * `fetch` that cannot be talked into dialling a private address.
 *
 * ## Why this exists rather than another call to `assertSafeExternalUrl`
 *
 * That guard resolves the hostname, decides, and then hands the *hostname* to
 * whatever dials it — which resolves it a second time. Between those two
 * lookups the answer can change (DNS rebinding), so a name that was public when
 * checked can be loopback when connected to. Checking harder before the call
 * cannot close that gap: any check that finishes before the socket opens is by
 * construction a different resolution from the one the socket uses.
 *
 * So the check moves *into* the connection's own resolution. undici lets a
 * dispatcher supply the `lookup` its connector uses, and the address returned
 * from there is the address the socket connects to — there is no second lookup
 * to disagree with it. TOCTOU closed, not narrowed.
 *
 * ## Why not "resolve, then dial the IP"
 *
 * The obvious alternative — rewrite the URL to `https://93.184.216.34/…` and
 * set a `Host` header — breaks TLS: SNI would carry the IP and certificate
 * validation would fail against it. Fixing that needs `servername` control,
 * which needs a dispatcher anyway. Same dependency, worse behaviour.
 *
 * `assertSafeExternalUrl` stays where it is and keeps its job: telling an admin
 * typing into a settings form that the URL is wrong, in words, immediately.
 * This is the runtime half, and it is the one that is load-bearing.
 */

/**
 * Built once and shared: an `Agent` owns a connection pool, so a per-request
 * instance would throw away keep-alive and leak sockets.
 */
let guarded: Agent | undefined;

function guardedAgent(): Agent {
  guarded ??= new Agent({ connect: { lookup: guardedLookup } });
  return guarded;
}

/**
 * `dns.lookup`, refusing any answer that points inside.
 *
 * undici calls this with `all: true`, so the callback receives an array — but
 * the `dns.lookup` contract has two shapes depending on that flag, and getting
 * it wrong would fail open (an unrecognised shape that is passed through
 * unchecked). Both are handled, and anything unrecognised is refused.
 */
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family);

    const answers = Array.isArray(address) ? address.map((a) => a.address) : [address];

    // Deny by default: an answer in a shape we cannot read is not an answer we
    // may connect to. The graph query wrapper makes the same choice about rows
    // carrying no workspace.
    if (answers.length === 0) return callback(blocked(hostname, 'unresolvable'), '');
    const bad = answers.find((a) => isPrivateAddress(a));
    if (bad) return callback(blocked(hostname, bad), '');

    callback(null, address, family);
  });
}

function blocked(hostname: string, address: string): NodeJS.ErrnoException {
  // Deliberately not a translated message: it surfaces as a fetch failure in a
  // log or a tool result, never in a form next to a field, and the two callers
  // wrap it in their own user-facing text.
  const error: NodeJS.ErrnoException = new Error(
    `blocked: ${hostname} resolves to a private address (${address})`,
  );
  error.code = 'EBLOCKEDADDRESS';
  return error;
}

/**
 * Use for any URL whose target a user or a document chose.
 *
 * `allowPrivate` mirrors the flag `assertSafeExternalUrl` takes: a self-hosted
 * deployment pointing at its own network is a legitimate configuration, and in
 * that case this is a plain `fetch` with the default dispatcher.
 */
export function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  allowPrivate = false,
): Promise<Response> {
  if (allowPrivate) return fetch(input, init);
  // `dispatcher` is an undici option that Node's global fetch honours but does
  // not carry in its RequestInit type.
  return fetch(input, { ...init, dispatcher: guardedAgent() } as RequestInit & { dispatcher: Dispatcher });
}
