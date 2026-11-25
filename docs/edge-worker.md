# Edge Worker

`knowledge.hrustalq.dev` is served by the Cloudflare Worker in
[`../deploy/edge/worker.js`](../deploy/edge/worker.js), deployed with
[`../deploy/edge/deploy.sh`](../deploy/edge/deploy.sh). This document covers why
the Worker exists, which origin it should point at, and how to deploy it.

## Path

```
browser -> Cloudflare (knowledge.hrustalq.dev, proxied)
        -> Worker knowledge-edge
        -> https://<edge-origin>            Tailscale Funnel
        -> caddy :8088 on the Mac mini      Caddyfile in the deploy dir
        -> api / web / git
```

A Cloudflare Tunnel cannot connect from this network — its `*.cftunnel.com`
handshake is filtered on every egress — so the Worker is the Cloudflare side and
Tailscale Funnel is the way in. TLS ends at Cloudflare and again at the Funnel;
caddy sees plain HTTP on `127.0.0.1:8088` / `0.0.0.0:8088`.

### Production origin

Production runs on the **Mac mini** (`/Users/hrustalq/Homelab/infra/knowledge`,
compose project `knowledge`). Its Funnel is
`https://eldars-mac-mini.tail92dbf3.ts.net`, which forwards to caddy on
`127.0.0.1:8088`; there is no Traefik and no cluster in the path. The old
homelab k3s route (`edge.tail92dbf3.ts.net` -> Traefik -> caddy) is unreachable
and receives no public traffic.

`DEFAULT_ORIGIN` in `worker.js` and the `EDGE_ORIGIN` default in `deploy.sh`
stay at `https://edge.tail92dbf3.ts.net` so an upload that does not set
`EDGE_ORIGIN` keeps the previous behaviour. **The Mac mini must pass
`EDGE_ORIGIN` explicitly** (see below), otherwise a deploy would point the
Worker back at the dead cluster.

## Deployment

The Worker is uploaded as a script named `knowledge-edge` and bound to
`knowledge.hrustalq.dev` as a **Workers Custom Domain**. The custom domain owns
the DNS record (a proxied placeholder), so any pre-existing record for that
hostname must be deleted before the PUT succeeds.

```sh
cd deploy/edge
EDGE_SECRET=$(grep -E '^EDGE_SECRET=' /Users/hrustalq/Homelab/infra/knowledge/.env | cut -d= -f2-) \
EDGE_ORIGIN=https://eldars-mac-mini.tail92dbf3.ts.net \
CLOUDFLARE_API_TOKEN=$(cat /Users/hrustalq/Homelab/infra/cloudflare-api-token) \
  ./deploy.sh
```

Expected output:

```
uploaded knowledge-edge (origin https://eldars-mac-mini.tail92dbf3.ts.net)
bound knowledge.hrustalq.dev
```

The token needs **Workers Scripts:Edit**, **Workers Routes:Edit** and **DNS
edit** on zone `hrustalq.dev` (account `732a440bd3e391f72fc389d72e133846`).
`deploy.sh` reads it from `CLOUDFLARE_API_TOKEN`, falling back to
`~/Homelab/infra/cloudflare-api-token` (chmod 600).

### Bindings

Every upload replaces the Worker's bindings, so `deploy.sh` sends both of them
each time:

| Binding       | Type       | Value                                          |
| ------------- | ---------- | ---------------------------------------------- |
| `EDGE_SECRET` | secret     | the production `EDGE_SECRET` (32+ lowercase hex) |
| `EDGE_ORIGIN` | plain text | `https://…`, default `https://edge.tail92dbf3.ts.net` |

`worker.js` resolves the origin as `env.EDGE_ORIGIN` when it is an `https://`
URL (trailing slashes trimmed), and falls back to `DEFAULT_ORIGIN` for anything
else — an empty binding, a `http://` URL or a non-URL string. `deploy.sh`
refuses to upload an `EDGE_ORIGIN` that is not a bare `https://host[:port]`.

## Headers

The Worker deletes any visitor-supplied `X-Knowledge-Edge`,
`X-Knowledge-Client-IP` and `X-Knowledge-Host`, then, when `EDGE_SECRET` is
bound, sets them again from `CF-Connecting-IP` and the request host. Funnel
overwrites `X-Forwarded-For` / `X-Forwarded-Host` with its own view, so the
visitor travels in these headers instead; Caddy trusts them only when
`X-Knowledge-Edge` matches `$EDGE_SECRET` (see `Caddyfile`), and then writes the
real `X-Forwarded-*` for the API and web. It also sets `X-Edge-Host` (routing
only, needed by the cluster's Traefik; the Mac mini's Funnel points straight at
caddy) and `X-Forwarded-Proto: https`.

Redirects are passed through unchanged (`redirect: 'manual'`), and WebSocket
upgrades (`/api/v1/events/ws`) pass straight through `fetch()`.

## Verification

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://knowledge.hrustalq.dev/            # 307 -> /sign-in 200
curl -s -o /dev/null -w '%{http_code}\n' https://knowledge.hrustalq.dev/api/docs    # 200
curl -s -o /dev/null -w '%{http_code}\n' https://knowledge.hrustalq.dev/api/v1/events \
  -H 'accept: text/event-stream'                                                    # 401
curl -s -o /dev/null -w '%{http_code}\n' https://eldars-mac-mini.tail92dbf3.ts.net/ # 200 (origin)
```

If a curl gets a Cloudflare 403 challenge page, retry with a browser
`User-Agent`; a challenge page is not a successful deployment.
