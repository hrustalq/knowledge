# 52 — API reference: OpenAPI and AsyncAPI specs as documents

Issue [#78](https://github.com/hrustalq/knowledge/issues/78), shipped as nine
PRs (#258–#265 and the one carrying this document). Teams documented an API
twice: the spec lived in the repository, and the prose about it lived here.
Use-case and endpoint pages named operations as free text, so nothing noticed
when an operation was renamed, removed or made stricter.

Now a spec is a document like any other, with revisions, branches, merge
requests and permissions, and every operation in it is a graph entity. Pages
link to operations, a merge request on the spec says which of its changes
break clients and which pages they affect, and the drift check
([35](35-pr-drift-check.md)) compares the spec with the routes the code
declares.

## What

- **A spec kind.** `documents.kind` is `page` (the default), `openapi` or
  `asyncapi`. OpenAPI 3.0, 3.1 and Swagger 2.0 (upgraded to 3.1 on read) are
  accepted, and so are AsyncAPI 2.x and 3.x, as YAML or JSON. A spec is
  created inline (`POST /v1/documents` with `kind` and `content.format`
  `yaml` | `json`), from the spec editor, or by repo sync. It is validated
  before the page exists and again at finalize. A spec that does not validate
  is a 422 (`code: UNPROCESSABLE`) with the validator's messages in
  `details.issues`.
- **Operations as entities.** Ingestion stores one `api_operations` row per
  operation or channel per revision and writes `document -DESCRIBES-> op:…`
  (or `channel:…`) for each. Search, BM25 and the assistant read the spec
  through a markdown projection, with no code of their own.
- **A reference reader.** `/documents/:id` on a spec renders `ApiReferenceView`
  instead of the page canvas: one Swagger-style card per operation, grouped by
  tag, with parameters, bodies, responses or messages, schemas as a field tree,
  examples, and the pages that link the operation. An **Operations** card in
  the rail indexes them. `?op=<entityKey>` lands on one operation.
- **Code samples and try-it.** Every HTTP operation shows cURL, JavaScript
  `fetch`, Python `requests` and Go `net/http`. A Postman-style console sends
  the request from the browser, or through an opt-in proxy that is off by
  default.
- **Linking.** A page links an operation through **Link API operation** in
  page settings, an API block's **Link to spec**, or `relations:` in
  frontmatter. All three write the same entity key. A fan-out workflow step
  can tag items with operations, and the endpoint draft under each item
  declares `DESCRIBES` on its operation.
- **A classified diff.** Between any two revisions of a spec, every change is
  one rule from a closed catalogue, `breaking`, `non-breaking` or `info`. It
  is shown in the revision compare and in a merge request's **API changes**
  tab, with the pages that link each changed operation.
- **A merge gate.** A workspace can refuse to merge a breaking change until an
  admin acknowledges it.
- **Repo sync.** Markdown / Git and Codebase connectors sync spec files named
  by globs. After the first sync, every change to a spec arrives as a merge
  request.
- **Spec ↔ code drift.** The sentinel compares a synced OpenAPI spec with the
  routes the repository declares, on a pull request or on demand.

## The rules

**The key.** `op:<slug>:<METHOD> <path>` for an HTTP operation,
`channel:<slug>:<address>` for an AsyncAPI channel, built by
`operationEntityKey` / `channelEntityKey` (`@knowledge/contracts/api`). Path
parameters fold to `{}` **inside `normalizeEntityKey`**, for `op:` and
`channel:` keys only. Every writer calls that function, so a page whose
frontmatter names `op:billing-api:GET /users/{userId}` lands on the vertex the
spec wrote for `/users/{id}`. The canonical form is lower-case with whitespace
kebabed: `op:billing-api:get-/users/{}`.

**The slug.** `apiSpecSlug(x-knowledge-key ?? info.title)`, pinned on
`documents.spec_slug` at the first indexed revision. A later title edit does
not move it. Only an `x-knowledge-key` on the default-branch head re-pins it;
a branch revision with a new key shows its operations under that key without
moving the live entities first.

**Matching in a diff.** Operations match by what a client calls: method plus
folded path, or channel address plus action. Never by array index and never by
entity key. Reordering parameters, renaming a path parameter (matched by
position), changing a header's case or re-pinning the slug is no change.

**Severity.** `API_CHANGE_RULES` (`@knowledge/contracts/api/diff`), 23 rules:

| Severity | Rules |
| --- | --- |
| breaking | `operation-removed`, `required-param-added`, `param-became-required`, `param-type-changed`, `request-body-required`, `request-property-required-added`, `property-type-changed`, `enum-value-removed`, `response-status-removed`, `response-property-removed`, `security-requirement-added`, `channel-removed`, `message-payload-field-removed` |
| non-breaking | `operation-added`, `optional-param-added`, `param-removed`, `response-status-added`, `security-requirement-removed`, `channel-added` |
| info | `operation-deprecated`, `enum-value-added`, `response-property-added`, `message-payload-field-added` |

Breaking means a client written against the old spec can fail against the new
one. A request-side removal is not breaking, because a server ignores what it
no longer reads. A response-side addition is only info.

**The gate.** `breakingBlocks(policy, diff, mr)` is true when the policy is
`block`, the diff from merge base to source head has a breaking change, and
there is no current acknowledgement. The panel, the merge widget and `merge()`
read that one predicate.

**Drift.** Routes match operations by method and folded path, so `:id`,
`{id}` and `{userId}` are one path. One leading prefix (such as `/v1`) may sit
between the two sides: the one that aligns them best, and none on a tie. A spec
`HEAD` is served by a route `GET`, and a spec `OPTIONS` is never reported
missing. `missing-in-spec` is judged against every spec of the repository and
filed under the spec whose paths share the longest lead with the route. When
no route is read at all, the result is "not compared", never "every operation
missing".

## Decisions

**A spec is a document, not a new store.** Branches, merge requests, history,
compare and page permissions come for free. `kind` defaults to `page`, so the
column reproduces today with no backfill. `api_operations` is a projection of
a revision, deleted and recreated with that revision's ingestion like
`upsertRevisionChunks`; it exists so the rail, the picker and the MR panel are
SQL reads instead of a re-parse.

**Ingestion branches on the kind, not the content type.** A `text/yaml` body
would pass the old content-type check and then be read as prose. The worker
renders a markdown projection (one `##` per tag, one `###` per operation,
parameters, body and responses as GFM tables, a cycle-safe schema walk) and
hands it to the unchanged split → chunk → embed → graph → fulltext path. That
is why searching an operation summary finds the spec with no new search code.
The revision is stored as `source.yaml` / `source.json` under
`application/vnd.oai.openapi+…` or `application/vnd.aai.asyncapi+…`
(`StorageService.sourceObjectName`).

**`extractor: 'spec'`, not `'explicit'`.** Explicit edges are document-level
and always live. A branch revision of a spec would then publish its operations
into the live graph before the merge. `spec` joins
`REVISION_SCOPED_EXTRACTORS` beside `frontmatter` and `inferred`, so it follows
the live projection, and the frontmatter replace never wipes it.

**`@scalar/openapi-parser` for OpenAPI, an in-house reader for AsyncAPI.**
Scalar validates 2.0, 3.0 and 3.1 as written, upgrades to 3.1 and dereferences
internal `$ref`s. No fetch plugin is passed, so a remote `$ref` is a
validation error and never a request (a test spies on `fetch`).
`@asyncapi/parser` was too heavy for the worker image; AsyncAPI 2.x and 3.x go
through a small reader on js-yaml with the same normalize and dereference.

**`GET /v1/api-specs/:id` keeps internal `$ref`s.** A recursive schema
dereferences to a cyclic object, which JSON cannot carry. The reader resolves
refs one hop at a time (`lib/api-spec.ts`) and marks a recursive type instead
of following it. `GET /v1/documents/:id/content` returns a spec verbatim,
because gray-matter would take a YAML `---` for frontmatter.

**A custom renderer, not `@scalar/api-reference`.** Scalar's reference was
about 49 MB unpacked with 27 dependencies, has no Russian, brings its own
theme, and its built-in client sends requests around the proxy and the ACLs.
The operation model is ours either way. Cards follow Swagger UI's opblocks in
the panel ramp (GET note, POST tip, PUT warning, PATCH important, DELETE
caution), because emerald, amber and red belong to the indexing lifecycle
(DESIGN.md's Reserved Signal Rule). One set of rules in `editor.css`
(`.kn-op`, `.kn-api`, `[data-kn-api]`) styles the spec card, the API block and
its rendered markdown. Washes onto the card mix `in oklab`: the light `--card`
is `oklch(1 0 0)`, and an oklch mix turned the blue GET wash pink.

**One request model for samples and try-it.** `sampleRequestFor`
(`@knowledge/contracts/api/samples`) builds a `SampleRequest` from the spec.
Each language printer reads it, and `resolveSampleRequest` fills the
credential slots at send time, so the sample and the sent request cannot
drift. It lives in contracts because the REST route and the MCP tool print
the same samples. Credentials appear only as environment variables (`$TOKEN`,
`process.env.TOKEN`, `os.environ['TOKEN']`, `os.Getenv("TOKEN")`). An
`x-codeSamples` / `x-code-samples` entry wins per language and is labelled as
the author's.

**Browser-direct by default; the proxy guards the request, not the client.**
Sending from the reader's browser uses their own network and credentials, so
it is safe for us; when the target refuses CORS, the console says so. The
proxy (`ApiTryService`) checks, in order:

1. The mode: the workspace's `api_try_proxy_mode`, clamped to
   `API_TRY_PROXY_MODE` (default `off`, which refuses before anything else is
   read). The settings page shows both the mode asked for and the mode in
   force.
2. A per-person rate limit in Redis (`PublicRateLimiter`, fails closed).
3. The body cap, 256 KB (`API_TRY_MAX_REQUEST_BYTES`).
4. The target: a concrete server of **the revision being viewed**, and a path
   matching one of that revision's operation templates. A free-form server
   variable is its default, never a wildcard.
5. The workspace's source policies (feature [25](25-web-research.md)):
   `allowlist` reaches only hosts they allow, `open` any public host they do
   not block. One host list, not two. `SourcePolicyService.decide` takes
   `{ allowPrivate }` so the proxy reads `API_TRY_ALLOW_PRIVATE_URLS`.
6. `safeFetch` with the DNS lookup pinned in the connection, so a name that
   rebinds to a private address at dial time is refused. `redirect: 'manual'`:
   a 3xx is returned, not followed. The response body is capped and returned
   `truncated`.
7. Headers: `Set-Cookie` is dropped from the response; `Cookie`, `Host`,
   hop-by-hop and `X-Forwarded-*` are not forwarded, and `droppedHeaders`
   lists what was dropped.
8. The audit row: method, host and path template. Never headers or bodies.

It needs the editor role and is not an MCP tool: an agent must not be able to
fire arbitrary HTTP through us. Credentials stay in the tab's `sessionStorage`.

**Linking writes an ordinary relation.** The picker adds an `IMPLEMENTS` row
with the canonical key. A linked API block carries `data-kn-op`;
`readApiOperationRefs` (`common/relations.ts`) reads it as an `IMPLEMENTS`
fact in the frontmatter class, replaced per revision and scoped to the branch
like `relations:`. Only `op:` / `channel:` keys count, so a block cannot make a
page implement a service. A linked block keeps only the author's summary and
renders parameters, body and responses live from the spec's head. When the
operation leaves the spec, it says so instead of going stale. No new edge type
was needed: `DESCRIBES`, `IMPLEMENTS` and `DEPENDS_ON` already covered it.

**Workflows gain an input, not a step kind.** `ai.generate` is offered the
operations the source page links, or a spec's own when the run is against a
spec, read under the run's audience scope and wrapped untrusted (origin
`spec`). An item's `operationKey` survives only if it was offered. The
`ai.draft` below it reads that operation's projection section and declares
`DESCRIBES` first and deterministically, whatever the model proposed.
`WORKFLOW_STEP_KINDS` is unchanged.

**The diff is cached by version.** `ApiSpecDiffService` caches in
`revision_diffs` under `api-semantic-v1`. The version is part of the format,
so a rule change cannot serve stale verdicts. Schemas are walked side by side
with a depth cap and a visited set, because dereferenced specs are cyclic.

**The ack is pinned to the source head.** The issue chose one column,
`breaking_ack_by`. Three shipped (`_by`, `_at`, `_revision_id`), because an ack
that survived a later push would let an author add breaking changes after an
admin approved the first ones. A push makes the ack stale (`ack.current:
false`) and the gate closes again. The policy is a sparse
`workspace_settings.api_breaking_change_policy` with no env ceiling; `null` is
`warn`, which never refuses a merge.

**Every synced spec change is a merge request, in every sync mode.** The first
sync creates the page. After that a change opens an MR with the conflict
reason `spec-changed` on a `spec/<run>-…` branch, including in `review` and
`step` runs, unlike the repo wiki. A sync that wrote the page directly would
get around the breaking-change gate. A newer change to the same file
supersedes the open MR (`SUPERSEDING_CONFLICT_REASONS`, shared with
`regenerated`). Specs are never pushed back: the stored copy can be a bundle
of many files.

**Bundling resolves only what is in the snapshot.** `adapters/repo-specs.ts`
inlines the first reference to a sibling file and turns later references, and
cycles back into it, into internal `$ref`s to where it was placed. That keeps
shared schemas shared and cross-file recursion finite. Remote, missing and
repo-escaping refs are left as written and reported as run warnings; the
parser then refuses a remote ref at finalize, the same answer an upload gets.
The version is the hash of the bundle, so editing a referenced sibling changes
the spec. `apiSpecs` is a comma- or newline-separated string (connector config
values are strings), read by one helper, `apiSpecGlobs`. A file under a glob
that declares no `openapi`, `swagger` or `asyncapi` key, such as a schema
fragment, is skipped quietly.

**Spec pages are not judged by a model.** A spec page is the repository's
file: a model-written body would bypass the sync and its breaking-change MR,
and the next sync would overwrite it. The spec's finding (`AgentFinding.apiDrift`)
is the deterministic comparison and carries no draft. Prose pages tied to the
same pull request get the mismatch list in their judgement prompt, wrapped
untrusted.

**A pull request reports only what it introduces.** The check overlays the
changed files read at the head (the `headImports` rule from
[51](51-component-pages.md)) and diffs the mismatch sets base → head.
Pre-existing drift in a PR comment would blame the reviewer for a state they
did not create. The on-demand check reports everything. A pull request that
touches neither a spec nor a file declaring a route returns `null`, so the
spec is not tied. Route extraction reads the whole archive, not `subdir`,
because a docs connector's spec describes code outside `docs/`.

**Extraction is partial on purpose.** `route-extract.ts` reads NestJS
(`@Controller`, `@Get`…, `@Sse`, `setGlobalPrefix`; `@ApiExcludeController`
and `@ApiExcludeEndpoint` honoured), Express, Fastify, Hono and Koa (only in a
file that imports one, which keeps `axios.get('/users')` out), FastAPI
(`APIRouter(prefix=)`, `include_in_schema=False` skipped), and Go `net/http`,
gorilla, chi, gin, echo and fiber. Tests, fixtures, examples and vendored code
are not read. A non-literal path is counted as `dynamic`, never guessed.

## Test suites (#468)

Every HTTP operation card has a quick-action menu (the flask beside the lock)
whose first item is **Generate test requests**. It writes a QA suite for the
operation: positive and negative cases, each with a name, the rule it covers,
the request and the expected status and body, exported as **cURL** (one
command per case) or a **Postman Collection v2.1** (one folder, one request per
case, the status as a `pm.test`).

**Coverage is the spec's, not the model's.** `testCasesFor` in
`@knowledge/contracts/api/test-cases` lists the cases an operation requires —
a positive case per documented 2xx; a negative case per required query or
header parameter, per required body field and for the whole body when it is
required; per type violation; per enum value outside the set; both sides of
every `minimum`/`maximum` (and their exclusive forms), `minLength`/`maxLength`
and `pattern`; missing credentials when the operation is secured; and one per
documented 4xx/5xx. A query or header value is text on the wire, so only a
non-string type is "wrong" there. Path parameters get no missing case (that is
another route), cookie parameters none at all (samples never send them), body
fields are walked three levels deep through objects (not into arrays), and a
form body's fields are not walked.

The `tester` agent ([20](20-agents.md)) only fills: a realistic baseline
request and, per case id, a name, a sentence and what to check. A baseline
value that breaks the schema (`conformsToSchema`, the same rules the catalogue
covers) is dropped for the spec's own example. `buildTestSuite` then builds
every listed case from the baseline by the same `SampleRequest` model the code
samples print, so a sample and a case cannot disagree, and names any case the
model skipped. A `pattern:match` case needs a value that matches; when neither
the spec's example nor the model supplies one the run fails rather than store
a suite with a case that does not test what it says.

**Cached, keyed by what the suite is built from.** `api_test_suites` is unique
on spec document, entity key, `operationHash` (SHA-256 of
`operationFingerprint`: the operation, its path-level parameters, every `$ref`
it reaches, servers and security), `TEST_CASE_CATALOGUE_VERSION` and
`agentHash` (`testerConfigHash`: instructions, skill ids, provider and model).
A revision that does not touch the operation keeps the suite; one that does,
or an admin override of the tester, misses, and the next Generate asks the
model. Generate on a hit makes no model call and writes no `ai_usage` row.
**Regenerate** overwrites the row under its key. The card shows when the suite
was generated and from which revision.

**Who may generate.** Reading and exporting a cached suite needs viewer on the
spec. Generating needs viewer **and** the member capability
`api-test-suites.generate` ([06](../architecture/06-auth-acl.md#member-capabilities)),
checked by the route's guard and again by the run when it executes — revoking
it after the click fails the run before any model call. A second Generate
while a run for the same key is waiting joins it: the lookup and insert run
under one advisory lock per key. The model call is billed to the person as
`test-suite`.

## Surface

| What | Where |
| --- | --- |
| Tables | `documents.kind`, `documents.spec_slug`, `api_operations`, `workspace_settings`, `merge_requests.breaking_ack_*`, `api_test_suites` |
| Vocabulary | `@knowledge/contracts/api` (`API_DOCUMENT_KINDS`, keys, `API_TRY_PROXY_MODES`, `API_BREAKING_CHANGE_POLICIES`, `API_DRIFT_KINDS`), `…/api/diff` (`API_CHANGE_RULES`), `…/api/samples` (`CODE_SAMPLE_LANGS`, generator), `…/api/test-cases` (`testCasesFor`, `buildTestSuite`, `testSuiteCurl`, `testSuitePostman`, `operationFingerprint`) |
| Parse, project, read, diff | `api-spec.parser.ts` (`parseApiSpec`), `api-spec.projection.ts` (`renderSpecProjection`, `renderOperation`), `api-diff.ts` (`diffApiSpecs`), pure; `ApiSpecsService` (`project`), `ApiSpecReadService`, `ApiSpecDiffService` in `ApiSpecsCoreModule` (both processes) |
| Controllers, try-it, settings, drift check, test suites | `ApiSpecsController`, `ApiOperationsController`, `ApiSettingsController`, `ApiTryService`, `ApiSettingsService`, `ApiDriftCheckService`, `ApiTestSuiteRequestsService`, in `ApiSpecsModule` (API-only); `ApiTestSuitesService` (the store) in `ApiSpecsCoreModule`; the `tester` run in `AgentExecutor.writeTestSuite` |
| Ingestion | `IngestionProcessor` step 2 (spec branch) and 7a (`GraphService.replaceRevisionSpecFacts`) |
| Gate | `MergeRequestsService` (`breakingBlocks`, `assertBreakingAcknowledged`, `setBreakingAck`) |
| Sync | `adapters/repo-specs.ts`, `apiSpecGlobs`, conflict reason `spec-changed` |
| Drift | `connectors/adapters/route-extract.ts`, `agents/api-drift.ts`, `code-research/api-drift.service.ts` |

| Route | Access |
| --- | --- |
| `POST /v1/documents` with `kind` | editor; validates the spec first |
| `GET /v1/api-specs?workspaceId=&projectId=` | viewer, query, guests |
| `GET /v1/api-specs/:id?revisionId=` | viewer, document |
| `GET /v1/api-specs/:id/operations?revisionId=` | viewer, document |
| `GET /v1/api-specs/:id/samples?entityKey=&method=&lang=` | viewer, document |
| `GET /v1/api-specs/:id/diff?from=&to=` | viewer, document |
| `POST /v1/api-specs/:id/try` | editor, document; 403 when the mode is `off` |
| `POST /v1/api-specs/:id/drift-check` | editor, document; `202 { runId, existing }` |
| `GET /v1/api-specs/:id/test-suite?entityKey=&format=` | viewer, document; the cached suite or 404; `format=curl\|postman` answers with a file |
| `POST /v1/api-specs/:id/test-suite` `{ entityKey, regenerate? }` | viewer, document, capability `api-test-suites.generate`; `{ suite }` from the cache or `{ runId, existing }` |
| `GET /v1/api-operations?workspaceId=&q=&documentId=&entityKey=` | viewer, query, guests; operations at each spec's default-branch head |
| `GET` / `PATCH /v1/workspaces/:id/api-settings` | viewer / admin, workspace |
| `GET /v1/documents/:id/compare` | unchanged; gains `api` on a spec |
| `GET /v1/merge-requests/:id/api-changes` | viewer, merge request |
| `POST` / `DELETE /v1/merge-requests/:id/breaking-ack` | admin, merge request |

The samples and test-suite routes take `entityKey` as a query parameter (or body field), not a path segment,
because a key holds `/` and `:`. A page passed to a per-document route is a 400
`error.apiSpec.notSpec`.

| MCP tool | Guard |
| --- | --- |
| `knowledge_list_api_operations` | viewer; read tool |
| `knowledge_get_api_operation` (`lang` for samples) | viewer; read tool; returns the projection section and the linked pages |
| `knowledge_diff_api_spec` | viewer; read tool |
| `knowledge_create_revision` | unchanged guard; on a spec it takes `syntax: yaml \| json` and grafts no frontmatter |

None of them is in `WRITE_TOOLS`, and there is no try-it tool.

Web: `components/api-reference/` (`ApiReferenceView`, `ApiOperationDetail`,
`ApiSchemaTree`, `ApiCodeSamples`, `ApiTryConsole`, `ApiChangesPanel`,
`ApiDriftCheck`, `ApiTestSuite` with `use-test-suite.ts`, `ApiOperationPicker`, `ApiOperationEmbed`, and the shared
`ApiTabs`, `ApiCode`, `ApiTone`, `ApiMediaContent`), `pages/ApiSpecEditorPage.vue`
(`/create/spec`, `/documents/:id/spec`), `pages/ApiSettingsPage.vue`
(`/settings/api`), and the **API changes** tab on `MergeRequestDetailPage`,
shown only when the merge request is on a spec. In the graph view, `op:` and
`channel:` entities are squares that open their card in the spec.

## Operations

- Migrations `20261103100000_api_reference_kind` (`documents.kind`,
  `documents.spec_slug`, `api_operations`), `20261104100000_workspace_settings`
  and `20261105100000_api_breaking_changes` are additive. The previous image
  never reads them, so a rollback is safe. Nothing is backfilled: every
  existing document is a `page`, and an empty policy is `warn`.
- New env vars, all with defaults: `API_SPEC_MAX_BYTES` (5000000),
  `API_SPEC_MAX_OPERATIONS` (2000), `API_TRY_PROXY_MODE` (`off`, a ceiling),
  `API_TRY_ALLOW_PRIVATE_URLS` (`false`), `API_TRY_TIMEOUT_MS` (15000),
  `API_TRY_MAX_RESPONSE_BYTES` (1000000), `API_TRY_RATE_PER_MINUTE` (30). With
  the defaults the proxy refuses every request.
- Migration `20261204100000_api_test_suites` (#468) adds
  `workspace_members.capabilities` (JSONB, default `[]`, not backfilled) and
  `api_test_suites`. Additive; the previous image reads neither.

## Deliberate deferrals

- GraphQL SDL and gRPC; mock servers, SDK generation and a visual spec
  designer. Specs are edited as text, in a `<textarea>`, not a code editor.
- A system thread on the merge request for each breaking change to a linked
  operation. Posting it needs a trigger when the source branch's revision is
  finalized; a GET must not post.
- The import wizard (`/upload`) does not route `.yaml` / `.json` to a spec.
  The spec editor's **Load file** covers single uploads, and an upload must be
  one bundled file.
- An automatic `EntityAlias` when a title changes. The pinned slug makes it
  unnecessary.
- Try-it, drift and test suites for AsyncAPI: a channel has no HTTP request to
  send, no route to compare and nothing to test.
- For test suites (#468): a mock server, running the cases or asserting live
  responses, a suite for a whole spec at once, other export formats (Insomnia,
  HTTPie, k6) and an MCP tool. Suites under a key no head reaches any more are
  never purged; a document's deletion cascades them.
- An `operationKey` picker on the workflow canvas; items get keys from the
  fan-out step only.
- The static markdown renderer (published sites, previews) draws API blocks as
  plain tables and does not show a linked block's live operation. In read
  mode, a comment anchored inside a hand-written API table has nothing to draw
  on, because the table is redrawn as rows.
- A webhook push that only touches a referenced spec sibling waits for the
  next sync: a delivery names files, not bundles.
- Spec files above 1 MB never reach the archive (`MAX_FILE_BYTES` in
  `repo-archive.ts`), so they cannot sync, although `API_SPEC_MAX_BYTES` is
  5 MB.

## Verification

- Specs: `api-spec-parse.spec.ts` (3.0, 3.1, Swagger 2, AsyncAPI 2.6 and 3.0,
  remote `$ref` refused without a fetch, limits, key folding, projection,
  slug pinning, the 422 shape), `api-samples.spec.ts` (golden output per
  language, `x-codeSamples`, credentials never in a sample),
  `api-try-proxy.spec.ts` (mode off, targets outside `servers[]`, private and
  rebinding hosts, redirects, caps, dropped headers, audit, rate limit,
  read-only key), `workflow-operations.spec.ts`, `api-diff.spec.ts` (every
  catalogue rule emitted, reorder and rename are no change, recursion),
  `api-spec-sync.spec.ts` (bundler, globs, staging to an MR in every mode,
  supersede), `api-drift.spec.ts`, and the extended `pr-drift.spec.ts` and
  `relations.spec.ts`. `api-breaking-gate.e2e-spec.ts` needs live infra and is
  not in CI; it passed locally (warn vs block, the 409, ack, a stale ack after
  a push).
- Live on dev, phase by phase: an OpenAPI 3.0 spec indexed with its
  `DESCRIBES` edges and was found by an operation summary; the reader and
  try-it were driven in Chrome in ru and en, dark and light, and a 390 px
  frame, with sends to httpbin from the browser and through the proxy;
  `swagger-api/swagger-petstore` synced as a spec, and switching its branch
  opened an MR reporting 6 breaking and 32 non-breaking changes; this
  repository's routes against `apps/api/openapi.json` matched (405 routes, no
  disagreements) through **Check against the code**.
- Not checked live: a real pull request or webhook through the drift path, the
  web mismatch list with actual rows, the connector review pane's text view
  and the setup dialog's spec suggestions.
