// knowledge.hrustalq.dev -> the Mac mini's Tailscale Funnel -> caddy on
// 127.0.0.1:8088. A Cloudflare Tunnel cannot connect from the Mac mini's
// network (its *.cftunnel.com handshake is filtered on every egress), so this
// Worker is the Cloudflare side and Funnel is the way in.
//
// Deploy: EDGE_SECRET=… ./deploy.sh (Workers Scripts:Edit + Workers Routes:Edit
// token). The Caddyfile depends on the three X-Knowledge-* headers below, which
// is why this file lives in the repo beside it (#174).
const ORIGIN = 'https://eldars-mac-mini.tail92dbf3.ts.net';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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

    // WebSocket upgrades (/api/v1/events/ws) pass straight through: fetch()
    // with an Upgrade header returns the origin's 101 and its socket.
    // redirect: 'manual' so a Location the app sets reaches the browser as-is.
    return fetch(ORIGIN + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });
  },
};
