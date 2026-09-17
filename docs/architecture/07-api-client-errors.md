# 07 — Generated API client & the strict error contract

## What this is

The web app never hand-writes a request shape and never branches on an error
message. One OpenAPI document is emitted from the API's own route metadata,
`openapi-typescript` turns it into `apps/web/src/api/schema.d.ts`, and a thin
axios layer is typed against it — so a renamed route, a dropped query parameter
or a changed request body is a compile error in the browser bundle rather than a
404 at runtime.

The other half is the error envelope. Every non-2xx response — and every
client-side failure that never reached the server at all — arrives as the same
`ApiErrorPayload`, which is what makes `error.code` the only branching surface
in the app.

## The chain

`make api-client` runs the whole thing; nothing in it needs infrastructure.

| Step                   | What happens                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `make api-schema`      | `apps/api` builds, then `node --env-file=apps/api/.env apps/api/dist/scripts/generate-openapi.main.js --out apps/api/openapi.json` |
| `make docs-reference`  | `pnpm --filter @knowledge/web run generate:docs` → `apps/web/scripts/generate-docs-reference.mjs` → `apps/web/src/pages/docs/reference.generated.json` |
| `generate:api`         | `openapi-typescript ../api/openapi.json -o src/api/schema.d.ts`                                                               |
| `typecheck`            | `vue-tsc -b` over the web app, against the schema that was just emitted                                                       |

All three generated artifacts — `apps/api/openapi.json`,
`apps/web/src/api/schema.d.ts` and `reference.generated.json` — are committed.
The typecheck is part of the target rather than a separate courtesy: the point
of regenerating is to find out immediately which call sites the API change
broke.

## Why the schema is emitted without starting a server

`apps/api/src/scripts/generate-openapi.main.ts` is the **fourth entrypoint**
(after `main.ts`, `worker.main.ts` and `mcp.main.ts` — see
[01-entrypoints-modules.md](01-entrypoints-modules.md)). It calls
`NestFactory.create(AppModule, { logger: false, abortOnError: false })` and then
stops: the DI graph is resolved and the route metadata is scanned, but the app
is never `init()`-ed or `listen()`-ed, so no lifecycle hook fires and neither
Postgres, MinIO, ArcadeDB nor Redis has to be up to regenerate a client.

A valid env file is still required, on purpose — zod fail-fast runs during
module construction, so a variable that has no default (or a bad value) fails
the generation exactly as it would fail a boot. This is the reason
`I18N_DEFAULT_LOCALE` and friends must declare defaults.

The script exits with `process.exit(0)` after `app.close()`: BullMQ and ioredis
keep handles open, and a generator that hangs at the end of a Make target is
indistinguishable from one that is still working.

## One document, two consumers

`createOpenApiDocument(app)` in `apps/api/src/config/swagger.ts` is the single
source of the document. `main.ts` passes it to `SwaggerModule.setup('docs', …)`
for the live `/docs` page, and the generator writes the same object to disk —
so the schema a developer reads in the browser and the schema the client is
generated from cannot drift.

It does three things a `DocumentBuilder` call alone would not:

- declares the bearer scheme once (`kn_` API key or `ks_` session token, see
  [06-auth-acl.md](06-auth-acl.md)) and registers `ApiErrorResponse` as an
  extra model;
- stamps `4XX` and `5XX` responses referencing `ApiErrorResponse` onto **every**
  operation, because `ApiExceptionFilter` already guarantees that shape —
  consumers get typed errors with no per-route decorator;
- stamps the optional `Accept-Language` header parameter onto every operation
  for the same reason: every route honours it
  ([../features/18-i18n.md](../features/18-i18n.md)), so decorating each handler
  would be a hundred-plus copies of one fact.

Both loops use `??=`, so a route that declares its own `4XX` keeps it.

## The docs-reference digest

`generate-docs-reference.mjs` emits the two tables on the in-app docs page that
nobody should maintain by hand: the REST endpoint table (method, path, tag,
summary — from `openapi.json`) joined with the role each endpoint requires
(scanned out of `@Access` / `@Public` / `@PlatformAdmin` decorators in
`apps/api/src/**/*.controller.ts`), and the MCP tool table (scanned out of
`registerTool(…)` calls in `mcp/mcp.service.ts`).

It is a **source scan, not runtime introspection**, because the MCP server
speaks stdio and would need the whole infrastructure up just to list its own
tools. A scan can go stale silently, so the script carries floors —
`MIN_ENDPOINTS = 100`, `MIN_TOOLS = 20` — and exits non-zero rather than
writing an empty page. Its summary line also counts endpoints with no `@Access`
at all, which is the exact gap a new route falls into: authenticated, but with
no workspace check.

The output is committed for the same reason `schema.d.ts` is: the web app does
not reach across the workspace boundary into `apps/api`, and a ~370 KB OpenAPI
document has no business in a browser bundle.

## The envelope is the contract

`ApiExceptionFilter` (`apps/api/src/common/api-exception.filter.ts`) is
registered in **`main.ts` only** — the worker and MCP entrypoints are untouched,
since neither answers HTTP. It normalizes every failure into `ApiErrorPayload`
from `@knowledge/contracts`:

```
{ statusCode, code, message, details?, path, timestamp, requestId }
```

- `code` comes from a stable, closed list (`API_ERROR_CODES`) — branch on it,
  never on `message`, which is translated. `errorCodeForStatus(status)` is the
  default mapping and is shared by the filter and the web client, so both sides
  agree on what a 409 is called.
- **Custom exception bodies keep working**: extra keys thrown as
  `new ConflictException({ statusCode, message, ...extras })` are hoisted into
  `details` — the merge-gate reasons, `currentHeadRevisionId`, `comparisonUrl`.
  This is why `details` is never nested by hand at a throw site.
- class-validator failures collapse to `VALIDATION_FAILED` with
  `details.errors: string[]`.
- Nest's router 404 for an unmatched path (`Cannot GET /v1/nope`) is the one
  message produced by the framework rather than a throw site, so it is
  recognised by pattern and translated here.
- `requestId` is the ambient trace id (`currentTrace()?.traceId`), falling back
  to the inbound `x-request-id` header and then to a fresh UUID. It is echoed
  as a response header too. Minting a new id here — which an earlier version did
  — meant a successful request had no id at all and a failing one had an id that
  correlated to nothing before it.
- Unexpected throws are logged with the error object and never leak internals to
  the client; 5xx `HttpException`s are logged with the same shape, so an
  `InternalServerErrorException` raised inside a service still arrives with a
  stack.

## statusCode 0: a network failure is an error with a code

`toApiRequestError` in `apps/web/src/api/http.ts` is the client-side twin. A
conforming body (`isApiErrorPayload`) passes through verbatim; a non-conforming
one — a proxy error page, a legacy shape — is synthesized from the status. What
matters is the third case: a failure that never produced a response becomes
`statusCode: 0` with `NETWORK_ERROR`, `TIMEOUT`, `ABORTED` or `UNKNOWN`.

Those four codes are declared in `API_ERROR_CODES` but are marked as
client-synthesized and never appear on the wire. The payoff is that a component
branches on `error.code` alone: there is no separate "did the request even
happen" question, no `instanceof AxiosError`, and an abort from an unmounted
component is a code rather than an exception shape.

`ApiRequestError` exposes `status`, `code` and `details` off the payload, and
the axios response interceptor rejects with it, so nothing downstream ever sees
a raw axios error.

## The web stack

Three files under `apps/web/src/api/`, each with one job:

- **`http.ts`** — the axios instance. `baseURL` follows the SSR split
  (`process.env.API_URL_INTERNAL` on the server, the Vite `/api` proxy in the
  browser — see [09-web-frontend.md](09-web-frontend.md)), 30s timeout, and a
  request interceptor that attaches the bearer token, `Accept-Language` and
  `x-request-id` from `lib/api`.
- **`client.ts`** — `api.get('/v1/documents/{id}', { path, query, body })`,
  typed against the generated `paths`. `buildUrl` throws on a missing path
  param instead of sending a URL with a literal `{id}` in it, and `signal` is
  forwarded to axios so vue-query's per-query abort actually cancels the HTTP
  request.
- **`queries.ts`** — vue-query integration. `createQueryClient()` is called per
  app instance from `src/main.ts` (never module scope: concurrent SSR renders
  would share a cache). The `Register` augmentation declares
  `defaultError: ApiRequestError`, which types the error of every `useQuery` and
  `useMutation` in the app. Retries are deliberate rather than default: at most
  two, and only for 5xx, `NETWORK_ERROR` or `TIMEOUT` — a 4xx is a contract
  error and retrying it is noise.

`apiQueryOptions(url, opts)` derives the query key from `[url, path, query]`, so
cache identity follows the schema rather than a hand-written string. The
optimistic-write composable `useApiMutation` is documented with the live cache
it cooperates with, in [08-events-live.md](08-events-live.md).

## Limits

Response bodies type as `unknown` wherever the schema declares no response
content — `ApiData<O>` falls back to it by construction. Tightening is per-route
and server-side: add `@ApiOkResponse({ type })` to the controller, or cast at
the call site with a `@knowledge/contracts` type. That is the one place the
generated client is weaker than it looks.

Two Swagger-decorator traps are load-bearing for this pipeline.
`openapi-typescript` promotes any property declaring a `default:` to
**required** in the generated client, forcing call sites to pass a value the
server already fills — describe the default in `description:` instead. And a
nullable field needs an explicit `type:`
(`@ApiPropertyOptional({ type: String, nullable: true })`); without it the
schema is typeless and the generated type becomes `Record<string, never>`,
which breaks the web typecheck at every call site that passes a real value.
