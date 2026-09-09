---
title: Complex places
section: Reference
summary: The traps — constraints that look arbitrary until the day you hit them, each with the reason it exists.
---

# Complex places

Every item here is a rule someone had to discover. They are collected in one place so the
next person does not have to.

## The API and the worker are the same app

Three entrypoints share one codebase: HTTP, the worker, and MCP. A fourth exists only to
emit the OpenAPI document — it builds the Nest app without initializing or listening, so
route metadata is scanned without touching infrastructure.

This means **module composition is load-bearing**:

- Modules holding **controllers with auth dependencies** must be API-only. The worker
  imports the services, not the controllers.
- The queue **producer** module is imported by both sides; the **processor** module only
  by the worker. Import the processor into the API module and the API process starts
  consuming jobs.
- When both sides need a service, it moves into a controller-free `*CoreModule` that each
  side imports — the existing module importing and re-exporting its core, so **no call site
  changes**.

**Worker generates, API publishes.** The worker cannot load the module that writes
documents (it pulls the access service, which belongs to the API's guards), so background
work leaves results in a `materializing` state and an API-side sweeper finishes them. That
is also the recovery path when a request dies mid-write.

## ESM

`apps/api` is `"type": "module"` with NodeNext resolution: **relative imports need the
`.js` suffix**, including from `.ts` sources — `./app.module.js`. There is no `__dirname`;
use `import.meta.dirname`.

## Buildless workspace packages

`packages/*` are imported as **source**, not built. Node strips types from the entry file
but will not follow a relative specifier into a sibling `.ts`, and strip-only mode rejects
TypeScript-only runtime syntax. So a buildless package is **one file**, with no
constructor parameter properties (`constructor(readonly x: T)`) and no enums.

## Generated client quirks

Two ways a Swagger decorator silently breaks the web build:

- **`default:` promotes a property to required** in the generated client, forcing every
  call site to pass a value the server already fills. Describe the default in
  `description:` instead.
- **A nullable field needs an explicit `type:`.** `@ApiPropertyOptional({ nullable: true })`
  alone emits a typeless schema that becomes `Record<string, never>`, and every call site
  passing a real value fails to typecheck. Write
  `@ApiPropertyOptional({ type: String, nullable: true })`.

## Validation and UUIDs

`@IsUUID()` rejects nil-style UUIDs — the version digit must be 1–5. The demo workspace id
is shaped to satisfy it (`11111111-1111-4111-8111-111111111111`), which is why it looks
odd.

## Dedupe is per branch

The uniqueness key is `(document, branch, contentHash)`. A merge revision legitimately
repeats the source head's bytes on the target branch, so dedupe must not span branches. It
never spans documents either.

## Migrations that add a NOT NULL column

`migrate dev` applies immediately, so it cannot express a backfill. Create the migration
with `--create-only`, hand-edit the SQL — add the column nullable, `UPDATE` it, then
`SET NOT NULL` — and apply it afterwards.

## Route declaration order

Nest matches in declaration order, so specific routes must be declared **before**
parameterized ones: `/v1/entities/trace` before `/v1/entities/:key`, `/v1/documents/tree`
before `/v1/documents/:id`, `/v1/glossary/suggest` before `/v1/glossary/:id`.

## Custom 409s use flat extras

Throw `ConflictException({ statusCode, message, ...extras })`. The exception filter hoists
the extras into `details`. Never nest a `details` object by hand — it ends up doubly
nested and the typed client stops seeing it.

## Anchoring is quote-based

Comments store the quoted text plus surrounding context, not a position. Resolution
normalizes whitespace, finds every occurrence, and scores by how much of the surrounding
context survives. **An unresolvable quote is reported outdated, never silently
re-anchored** — landing a comment on the wrong paragraph is worse than admitting the
paragraph is gone.

Both the read view and the editor build the same projection of the text (whitespace
collapsed, one synthetic space per block boundary), which is what lets an anchor written on
one surface resolve on the other.

## Events are split in two

The publisher module is worker-safe; the subscriber and its controller are API-only.
Otherwise the worker would try to instantiate an SSE controller and a WebSocket gateway it
has no server for.

## Reindexing is idempotent by construction

Upserting a revision's chunks deletes them first; completed jobs are skipped; frontmatter
and inferred edges are replaced per revision. This is what lets the stale sweeper, the
dependent cascade and a manual reindex all call the same code without coordinating.

## Guards do not run on WebSocket upgrades

Nor does i18n middleware. The gateway resolves the principal itself through the shared
token service, and background work runs inside an explicit locale scope.

## A converted label map still needs its render site

When a module-scope map is changed to hold message keys, every place that renders it must
resolve them. A map that ships keys renders `nav.ai` at the user and typechecks perfectly.

## Free-text values need a fallback

`documents.category` accepts anything, so a label lookup must degrade to the raw value
rather than rendering the missing key. Same for activity action codes and tool names.
