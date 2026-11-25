// knowledge.hrustalq.dev -> an app edge reached through Tailscale Funnel ->
// this app's caddy. Production is the Mac mini's Funnel
// (eldars-mac-mini.tail92dbf3.ts.net -> caddy 127.0.0.1:8088); the homelab
// cluster's Funnel (edge.tail92dbf3.ts.net -> Traefik -> caddy) stays the
// default so an upload without EDGE_ORIGIN keeps the old path. A Cloudflare
// Tunnel cannot connect from this network (its *.cftunnel.com handshake is
// filtered on every egress), so this Worker is the Cloudflare side and Funnel
// is the way in.
//
// Deploy: EDGE_SECRET=… [EDGE_ORIGIN=…] ./deploy.sh (Workers Scripts:Edit +
// Workers Routes:Edit token). The Caddyfile depends on the three
// X-Knowledge-* headers below, which is why this file lives in the repo beside
// it (#174).
const DEFAULT_ORIGIN = 'https://edge.tail92dbf3.ts.net';

/**
 * Picks the origin to proxy to: the EDGE_ORIGIN binding when it is a plain
 * https URL (trailing slashes trimmed), otherwise DEFAULT_ORIGIN. Anything
 * malformed — or a scheme other than https — is refused rather than fetched,
 * because the x-knowledge-* headers are only trustworthy over TLS.
 */
function resolveOrigin(env) {
  const configured = (env.EDGE_ORIGIN || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[^/]+/i.test(configured) ? configured : DEFAULT_ORIGIN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = resolveOrigin(env);
    const headers = new Headers(request.headers);

    // Funnel overwrites X-Forwarded-For and X-Forwarded-Host with its own view
    // (Cloudflare's egress address, the *.ts.net name), so the visitor travels
    // in headers Funnel leaves alone. The *.ts.net URL is public, so anyone can
    // send these too: Caddy believes them only alongside EDGE_SECRET, then
    // writes the X-Forwarded-* the API and web read. A visitor's own copies are
    // dropped first, and without the secret nothing is vouched for at all.
    headers.delete('X-Knowledge-Edge');
    headers.delete('X-Knowledge-Client-IP');
    headers.delete('X-Knowledge-Host');
    if (env.EDGE_SECRET) {
      headers.set('X-Knowledge-Edge', env.EDGE_SECRET);
      headers.set('X-Knowledge-Client-IP', request.headers.get('CF-Connecting-IP') ?? '');
      headers.set('X-Knowledge-Host', url.host);
    }
    headers.set('X-Forwarded-Proto', 'https');
    // The cluster edge is shared by every app and Funnel rewrites Host to the
    // ts.net name, so the cluster's router picked this app by X-Edge-Host.
    // Routing only: nothing trusts it, so no secret is needed for it. The Mac
    // mini's Funnel points straight at caddy, which ignores it.
    headers.set('X-Edge-Host', url.host);

    // WebSocket upgrades (/api/v1/events/ws) pass straight through: fetch()
    // with an Upgrade header returns the origin's 101 and its socket.
    // redirect: 'manual' so a Location the app sets reaches the browser as-is.
    return fetch(origin + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });
  },
};
