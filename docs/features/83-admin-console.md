# 83 — Platform admin console

Milestone [#1235](https://github.com/hrustalq/knowledge/issues/1235). A separate web app for running the
platform: configuration, monitoring, users and errors. Workspace settings keep workspace things.

| Phase | Issue | PR | What landed |
| --- | --- | --- | --- |
| 1 | [#1236] | [#1275] | `apps/admin`, its image and route; the platform-admin gate; `@knowledge/api-client` |
| 2 | [#1237] | — | The configuration view: `GET /v1/admin/config` |
| 3 | [#1238] | — | Monitoring |
| 4 | [#1239] | — | Users across workspaces |
| 5 | [#1240] | — | Errors over `ops_events` |

[#1236]: https://github.com/hrustalq/knowledge/issues/1236
[#1237]: https://github.com/hrustalq/knowledge/issues/1237
[#1238]: https://github.com/hrustalq/knowledge/issues/1238
[#1239]: https://github.com/hrustalq/knowledge/issues/1239
[#1240]: https://github.com/hrustalq/knowledge/issues/1240
[#1275]: https://github.com/hrustalq/knowledge/pull/1275

## The app and its door

`apps/admin` is a client-only Vite SPA built for the `/admin/` base and shipped as its own image
(`Dockerfile.admin`: static files behind Caddy, strict CSP, `/healthz`). The front `Caddyfile` routes
`/admin` and `/admin/*` on the app's own host to it, so the member app's HttpOnly session cookie reaches it.
There is no second sign-in: a signed-out visitor goes to the member app's `/login?redirect=/admin/…`, and
`LoginPage` / the SSO completion follow a return path into the console with a full load (`isOtherApp`),
because the member app's router cannot push there.

The router renders nothing until `GET /v1/me` answers. A platform admin (`users.is_admin`) or the dev
principal gets the console. Anyone else, a workspace admin included, gets the 403 page, and the console
calls no other route. A failed check shows a retry. This gate only keeps a non-admin from an empty console:
**the API is the door**, and every `/v1/admin/*` route carries `@PlatformAdmin()`, enforced in `AclGuard`.

The console is laid out in `apps/web`'s layers (`app → modules → entities → stores → shared`,
[architecture 11](../architecture/11-web-modules.md)) with the same dependency-cruiser layer rules. It shares
code with the member app only through packages: `@knowledge/ui`, `@knowledge/contracts` and
`@knowledge/api-client` (the generated schema, the typed request core, the error helpers and the vue-query
builders). `web-imports-no-admin` and `admin-imports-no-other-app` hold the boundary, so nothing of the
console ships in a member's bundle.

Locally, `make dev` serves it on :5174 and `apps/web`'s Vite proxies `/admin` to it. Open
`localhost:5173/admin`, where `/login` works. In production it needs the homelab `admin` Deployment
([#1274](https://github.com/hrustalq/knowledge/issues/1274)); until then `/admin` answers 404.

## Configuration

`GET /v1/admin/config` answers `AdminConfigResponse`: every key of `envSchema`, in schema order, as **this
API process** resolved it. Workers, the learner and the git remote resolve their own environment, and the
page says so rather than pretending to speak for them.

Each entry carries:

- **`group`**: derived from the key's name by `envGroupOf` (`config/env-report.ts`), longest prefix wins
  (`AI_READABLE_` is publishing, `AI_` is AI). Never stored. A spec fails when a key lands in `other`, so a
  new prefix joins the table.
- **`source`**: `env` when the environment set the key, `default` otherwise. `validateEnv` records the keys
  it was given (`providedEnvKeys`), because nothing later can tell: `@nestjs/config` writes the validated
  values, defaults included, back into `process.env`. An injected production default
  (`AUTH_REQUIRE_VERIFIED_EMAIL`) reads `default`.
- **`value`**: the effective value, or null. **A secret never has its value returned**, only `set`.
  `SECRET_ENV_KEYS` is the one list, and the DSNs are on it, because a password can sit in a query string.
  `env-report.spec.ts` fails when a key whose name matches `/SECRET|TOKEN|KEY|PASS/` is in neither it nor
  `NOT_SECRET_ENV_KEYS`. Every other URL value has its userinfo stripped on the way out.

The page lists the groups with a search over keys and (non-secret) values and an "only keys the environment
sets" filter. It is read-only: env is owned by the k3s manifests and the GitHub production environment.
