# 62 — QA: test fixtures, suite runs and the QA view

Issue [#483](https://github.com/hrustalq/knowledge/issues/483), shipped as six
PRs (#487–#491 and the one carrying this document), on top of the per-operation
QA suites of #468 ([52](52-api-reference.md#test-suites-468)). Those suites
assumed the world was already in the right state. Real endpoints have
prerequisites: `GET /invoices/{id}` needs an invoice that exists, almost
everything needs a token from a login in another spec, and some state ("a
merchant with KYC approved") no API can create. That knowledge lived in
someone's Postman workspace or in their head. The suite could not express it,
the exports could not run it, and an agent could not ask what to call first.

Now:

- a **test fixture** is a document holding that setup — calls with captures,
  manual notes, teardown;
- a suite **binds** fixtures, with candidates offered from the spec;
- a suite **runs** against a real server — from the browser, through the
  try-it proxy, or (opt-in) from the worker against a **test environment**;
- **`/qa`** shows which operations are ready to test and which need work;
- every capability has an **MCP twin** behind the same guard.

The mechanics are in [52](52-api-reference.md), one section per phase. This
document is the map, the rules that hold across the phases, and the decisions.

## The model

```
fixture (document, kind test-fixture)
   └─ bound to ─▶ suite of one operation (suite-level, or one case)
                     └─ testChain ─▶ TestRunPlan (placeholders, no value)
                                        ├─ exports: bash (curl + jq), Postman
                                        ├─ browser runner / proxy (values typed per run)
                                        ├─ agent with its own HTTP client (knowledge_get_test_run_plan)
                                        └─ server runner (values from a test environment)
```

| Piece | Where | Doc 52 section |
| --- | --- | --- |
| Fixture kind, finalize check, projection, `DEPENDS_ON` edges, broken-calls health filter | `@knowledge/contracts/api/fixtures`, `ApiFixturesService` | [Test fixtures](52-api-reference.md#test-fixtures-483) |
| Bindings, candidates (links → path-param producers → fixtures calling them), tester ranking, cache key, exports | `api_test_bindings`, `suitePrerequisites`, `testChain` | [Binding fixtures](52-api-reference.md#binding-fixtures-to-a-suite-483-phase-2) |
| Run plan and walker | `testRunPlan`, `runTestPlan`, `testRunCounts` | [Running a suite](52-api-reference.md#running-a-suite-483-phase-3) |
| Overview of every operation's state | `qaSuiteStatusFor`, `GET /v1/qa/overview` | [The QA view](52-api-reference.md#the-qa-view-483-phase-4) |
| Test environments and server runs | `ApiRunnerCoreModule`, `api_test_environments`, `api_test_runs` | [The server runner](52-api-reference.md#the-server-runner-483-phase-5) |

## The rules that hold everywhere

- **A secret is never a value in anything we store or hand out.** Fixtures
  write `{{secret.x}}`; finalize refuses a literal in an `Authorization`,
  `Cookie` or API-key slot. Plans and exports carry placeholders only. The
  browser runner keeps typed values in component memory for one run. A test
  environment's secrets are one `ai/secret-box.ts` envelope, write-only over
  the API, decrypted only by the worker; the job carries a run id, not a value.
  A stored run keeps no capture named like a secret (`isSecretName`).
- **One rule set, any client.** `runTestPlan` is the only walker: negative
  cases first, a failed setup step stops every case, a case runs between its
  own setup and teardown with its captures shadowed, teardown always runs and
  skips a step whose values were never captured. The browser, the server and
  an agent's own client get the same results from the same plan.
- **One egress path.** A request from us — the proxy's step or a server run's
  — goes through `ApiTryService`: the workspace's proxy mode, its source
  policies, `safeFetch` (private addresses refused in the connection's own
  lookup), only servers the step's spec declares, and the `api.try` audit
  (method, host, path template — never a header or body). A test environment's
  server is used only where a spec declares it, so it cannot widen that set.
- **Permission is a capability on top of viewer, checked on execution.**
  `api-test-suites.generate` binds and generates; `api-test-suites.run` runs
  ([06](../architecture/06-auth-acl.md#member-capabilities)). Each is checked
  by the route's guard, by the MCP tool's guard, and again by whatever executes
  later — the tester run, every proxied step, the server run when it starts.
  Reading fixtures, suites, bindings and run records needs viewer on the
  documents involved. A fixture the reader cannot open keeps its binding but
  loses its title; a run or export refuses rather than silently dropping it.
- **Derived, never stored.** A suite's state on `/qa`, a fixture's broken
  calls, a run's case counts are computed on read from rows that exist. The
  suite state uses the suite panel's own cache key, so the two never disagree.
- **Nothing is bound by a model.** Candidates come from the spec; the tester
  may order and explain them; a person presses Bind.

## Surfaces

| Capability | Web | REST | MCP |
| --- | --- | --- | --- |
| Create and edit a fixture | Steps / YAML editor (`/create/fixture`) | document routes, `kind: test-fixture` | `knowledge_create_document` / `knowledge_create_revision` (`kind`, `syntax`) |
| Fixture library | `/qa` → Fixtures | `GET /v1/test-fixtures` | `knowledge_list_test_fixtures` |
| One fixture, checked against today's specs | fixture page | `GET /v1/test-fixtures/:id` | `knowledge_get_test_fixture` |
| Suite and exports | operation card → Test requests | `GET /v1/api-specs/:id/test-suite[?format=]` | `knowledge_get_test_suite` |
| Generate / Regenerate | Generate | `POST …/test-suite` | `knowledge_generate_test_suite` (write) |
| Candidates, bindings | Setup section | `GET …/test-fixture-candidates`, `PUT …/test-bindings` | `knowledge_suggest_test_fixtures`, `knowledge_set_test_fixtures` (write) |
| Run plan | Run suite (browser / proxy) | `GET …/test-run-plan`, `POST …/test-run/send` | `knowledge_get_test_run_plan` |
| Run on server | Run suite → Server | `POST …/test-runs`, `GET …/test-runs[/:runId]` | `knowledge_run_test_suite` (write), `knowledge_get_test_run` |
| Test environments | `/qa` → Environments | `…/workspaces/:id/test-environments` | — (named by `knowledge_run_test_suite`) |
| Overview | `/qa` → Operations | `GET /v1/qa/overview` | `knowledge_qa_overview` |

There is no environment tool on purpose: an agent names an environment to run
against and never handles a secret. There is no try-it tool either; an agent
that wants to send requests itself takes the plan.

## Decisions

Settled with the user, phase by phase (each posted on #483):

- **Fixtures are documents**, not tables, so branches, review, permissions,
  search and the graph come with them. Steps are calls with captures plus
  manual notes; teardown always runs.
- **"Broken" means removed**: a called operation no spec head defines, or its
  spec archived. A breaking change to an operation that still exists does not
  flag a fixture.
- **Candidates follow spec order**, with an optional queued tester ranking kept
  on the run row and applied only to the candidate set it ranked. A binding or
  fixture edit is a cache miss until Generate; there is no auto-regenerate.
- **Per-case fixtures run just before their case**; their captures shadow the
  suite's for that case and their teardown runs right after it.
- **The browser runner**: a 429 waits out the limit and resumes; credential
  slots prefill from Try it (read only); each spec's requests go to the server
  picked in its Try-it console.
- **`/qa`**: two tabs plus Environments; **Outdated** is its own state; the
  sidebar link is always shown.
- **The server runner**: credentials from per-workspace test environments
  (secret-box, write-only), editable by editors on `/qa`; the environment's URL
  picks among the spec's servers; the last 20 runs per suite are kept; runs are
  manual only — no scheduling.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `API_TEST_RUNNER_MODE` | `off` | Ceiling for server runs; a workspace still opts in on Settings → API |
| `API_TRY_PROXY_MODE` | `off` | Also bounds the server runner: its steps go out through the proxy's mode |
| `API_TRY_ALLOW_PRIVATE_URLS` | `false` | Lets the proxy and the server runner reach private addresses |
| `SETTINGS_ENCRYPTION_KEY` | — | Needed to save a test environment's secrets |

## Deliberate deferrals

- **Scheduled server runs.** A due check inside a fixed tick, when asked for;
  agent triggers ([49](49-agent-triggers.md)) are the other route.
- **Response-body assertions**, parallel runs, load testing and retries of
  flaky cases. A run checks status codes only.
- **AsyncAPI fixtures and runs**: a channel has no request to send.
- **A mock server** answering fixture or case requests, and **importing**
  fixtures from Postman collections or environments.
- **Database seeding.** A manual step describes data; it never writes it.
- **Known ceilings in code** (`ponytail:` markers): a worker that dies mid-run
  leaves the run `running` (no stale-run sweeper); server runs are not metered
  per minute (a run is bounded by its plan); test-environment edits are not
  audited.

## Verification

Each phase was checked on the local stack against a mock API on 127.0.0.1
(details in each PR):

- **Fixtures:** finalize accepts a cross-spec login, body and header
  captures, a manual step and teardown; it refuses a removed producer (step
  named) and a literal `Authorization`. Impact analysis lists the fixture, and
  knowledge health flags it once the operation is deleted.
- **Bindings and exports:** for `GET /invoices/{id}` a fixture calling
  `POST /invoices` is offered with the spec's `links` target first, and nothing
  binds until Bind. Binding changes the cache key, and only suites bound to an
  edited fixture miss. The bash script runs end to end with jq, teardown after a
  failed case; the Postman collection runs under newman. Neither holds a secret.
- **Browser runner:** login and invoice captures, negative cases first, a
  failed case shown as Failed, teardown run, and a proxy run that waited out a
  429 and resumed.
- **`/qa`:** all 17 local operations matched the suite panel's own routes, and
  archiving a bound fixture flipped its row to Needs review.
- **Server runner:** refused until the workspace opted in; the environment's
  secret stored as a `gcm$` envelope; REST and MCP runs matched the browser
  run; `api.try` audit rows written under the run's owner with no secret.
- Light and dark, en and ru, and 390 px for each new surface.

Not checked live: a member without the capability (dev mode is the admin
principal; the guard path is the shared `requireRole(…, { capability })`), and
a manual import into the Postman desktop app.
