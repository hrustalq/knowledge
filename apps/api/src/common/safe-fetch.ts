import { Agent, buildConnector, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
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
 * A host that is already an address never reaches a lookup, so the connector
 * checks that case itself. Together they see every socket this opens, including
 * each hop of a redirect.
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
  if (guarded) return guarded;
  const connect = buildConnector({ lookup: guardedLookup } as buildConnector.BuildOptions);
  guarded = new Agent({
    connect: (options, callback) => {
      const host = options.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) && isPrivateAddress(host)) return callback(blocked(host, host), null);
      return connect(options, callback);
    },
  });
  return guarded;
}

/**
 * `dns.lookup`, refusing any answer that points inside.
 *
 * Exported for the one long-lived connection that is not a `fetch`: the chat
 * bot's websocket to a Time server (`ws` hands `lookup` to `net.connect`,
 * which calls it with `all: false` — the other shape below).
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

export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
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
 * that case this is a plain fetch with undici's default dispatcher.
 *
 * ## Why undici's own `fetch` rather than the global one
 *
 * A dispatcher and the `fetch` driving it are two halves of one private
 * interface, and undici changed it in v7: a handler now answers
 * `onRequestStart` where it used to answer `onConnect`. Node's global `fetch`
 * is backed by the undici *bundled with that Node*, so handing it an `Agent`
 * from the undici in `node_modules` makes every guarded call depend on those
 * two versions belonging to the same generation — which they do only by luck.
 *
 * They did not: on Node 24 and 25 (bundled undici 7.x) this package's undici 8
 * `Agent` rejects the global fetch's handler outright with
 * `UND_ERR_INVALID_ARG: invalid onRequestStart method`, and since undici
 * reports every dispatch failure as the bare words "fetch failed", it reached
 * users as `could not reach <url>` on every connector, plugin and web-research
 * call. Node 26 bundles undici 8 and works, which is what made the break look
 * like a property of the network rather than of the runtime.
 *
 * Driving the agent with the `fetch` from the same package removes the
 * coupling: both halves are now the dependency this repo installs and pins,
 * whatever Node runs it. What comes back is undici's `Response` — the same
 * WHATWG shape, from the same implementation the global one is built on — cast
 * once here so no call site has to know which of the two it is holding.
 */
export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  allowPrivate = false,
): Promise<Response> {
  const send = (url: string | URL, request: RequestInit) => {
    const options = request as UndiciRequestInit;
    return undiciFetch(url, allowPrivate ? options : { ...options, dispatcher: guardedAgent() }) as unknown as Promise<Response>;
  };
  if (init.redirect === 'manual' || init.redirect === 'error') return send(input, init);

  let url = new URL(input);
  let request: RequestInit = { ...init, redirect: 'manual' };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await send(url, request);
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
    await res.body?.cancel();
    const next = new URL(location, url);
    if (next.origin !== url.origin) request = { ...request, headers: withoutCredentials(request.headers) };
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && request.method === 'POST')) {
      request = { ...request, method: 'GET', body: undefined };
    }
    url = next;
  }
  throw new Error(`too many redirects from ${String(input)}`);
}

const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const SAFE_ACROSS_ORIGINS = ['accept', 'accept-language', 'user-agent', 'content-type'];

/**
 * What may follow a request to another origin. Followed by hand because undici
 * strips only `authorization`, `cookie` and `host`, and a source's credential can
 * be a custom header. An allowlist, so a header added later stays home by default.
 */
function withoutCredentials(headers: RequestInit['headers']): Headers {
  const kept = new Headers();
  const given = new Headers(headers);
  for (const name of SAFE_ACROSS_ORIGINS) {
    const value = given.get(name);
    if (value !== null) kept.set(name, value);
  }
  return kept;
}
