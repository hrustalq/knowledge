# 33 — Connect AI: MCP over HTTP, named API keys, the agent skill

Original request: «implement ability to connect mcps, full support, with examples
for all modern ais (e.g. codex, claude, gemini-cli etc), json config, api key
management, and also implement copy-paste skill fully integrated with our
platform»

## What

Any MCP client — Claude Code, Codex, Gemini CLI, Qwen Code, Kimi Code, DeepSeek
Harness, pi, Oh My Pi, Hermes Agent, Cursor, VS Code, Claude Desktop, Windsurf,
opencode, Zed — can connect to a deployment of this platform
and work in its knowledge base **as the person who connected it**:

- **`POST /v1/mcp`** serves the MCP tool set over Streamable HTTP inside the API
  process. Until now it existed only on stdio (`make dev-mcp`), which meant a
  checkout of this repo, local access to all three stores, and full, anonymous
  authority.
- **Named API keys** (`api_keys`), many per person, each optionally
  **read-only**, **pinned to one workspace**, or **expiring**; revoked
  individually; `last_used_at` so a stale one can be found. A third scope,
  **capture** ("Read & propose"), reads like a read-only key and may only
  propose agent-session captures, optionally pinned to projects
  ([50](50-agent-memory.md)).
- **Connect a client** (`/setup/connect`, #1225): a full-screen question-and-answer
  wizard. It asks who you are, which tool connects and what the agent will do, then
  derives the key (scope, suggested toolsets), shows that client's command and config
  file live beside the questions with the fresh key in them, installs the skill (and,
  for Claude Code and Cursor, the capture kit, below), and ends by **waiting for the
  key's first call**. Every step carries a "Something not working?" panel: symptom →
  fix, for the step and for the chosen client.
- **Settings → AI → Connect AI** (`/settings/ai/connect`; it was its own settings row
  at `/settings/connect` until issue #182, and that URL — printed in every SKILL.md
  already handed out — redirects) is the manage side: the endpoint, your keys (revoke,
  last used, captures), the offered tools and the llms.txt URLs. `?client=` on either
  URL opens the wizard on that client.
- **The skill.** A `SKILL.md` generated per caller at `GET /v1/mcp/skill`: the
  workspaces and project ids that credential reaches, the tools it is offered,
  and the playbooks — answer with citations, change a page only through a merge
  request, trace impact. The MCP server also serves it as the resource
  `knowledge://skill` and the prompt `guide`, so a client with no skills
  directory can still load it.

## Decisions

**Stateless HTTP.** Each POST builds an `McpServer` bound to that request's
principal and discards it. No session store means nothing to pin a principal
to, nothing to leak between callers, nothing lost on restart or across API
replicas. The cost is no server push, so `GET` (the SSE stream) answers 405 —
the spec allows it and every client tested falls back. Building a server is a
map insert per tool; it does not show up next to the tool call it serves.
It also means no HTTP caller can be **elicited** (the server cannot send a
request back), so the question flows of [61](61-question-flows.md) answer
`status: "needs_input"` over HTTP and the agent asks the person itself; only a
stdio client that declares `elicitation` gets a form.

**Page text over MCP is data, in the assistant's read-tool shape** (#1136,
following #1102). A tool whose result can carry text someone other than the
caller wrote answers with one line of plain JSON — ids, cite labels, trust
status, counts, dates — then that text (titles, breadcrumbs, headings,
snippets, markdown, diffs, comments, entity names) inside one
`wrapUntrusted(…, tool, 'document')` block, which a page containing the
block's closing tag cannot end. `common/page-text.ts` holds the split
(`splitPageText`: a string is a fact only under an id/enum/date key and shaped
like one, so an unknown field is wrapped), the composer and `readPageText`, which
merges the two back into one object for a client that wants it. One wrapper per
result, never per hit; the split walks the value once and replaces the
pretty-printed JSON, so a result costs about the same as before (measured in
#1136's PR). No `structuredContent`: a client that also feeds it to its model
would read every result twice. The tools that answer plain are listed with why
in `test/mcp-page-text.spec.ts`; a new tool fails there until it is one or the
other. The same spec fails a wrapped tool that gains a second, plain exit
(`json(…)` or a hand-built `text: JSON.stringify(…)`) unless it is listed with
why it carries only facts (#1141), and a resource read that hands back page text
unwrapped: `knowledge://documents/{id}.md` and both `llms.txt` resources answer
inside one `<documents>` block; only the skill resources (our own text) are plain.

**Two transports, one tool set, one guard.** `McpService.buildServer(principal)`
is the only place tools are registered: it builds the caller's guards and hands
them, with the server, to one registrar per section (`src/mcp/tools/*.ts`,
`registerSearchTools`, `registerDocumentsTools`, …), plus the capture and draft
tools. Every tool resolves its target to a
workspace in PostgreSQL and runs `AccessService.requireRole` with the same role
its REST twin's `@Access` declares — so a tool is exactly as permissive as the
route it mirrors, and a new tool without a guard stands out in review because
every other handler starts with one. stdio passes `DEV_PRINCIPAL`: local process
access _is_ the trust there, and it keeps `make dev-mcp` behaving as before.

**One exception to one tool set: the draft tools.** `knowledge_get_draft` and
`knowledge_suggest_draft_edit` ([56](56-realtime-coediting.md#mcp-agents-in-a-draft))
need the collab gateway, which only the API process runs. `McpController`
passes them into `buildServer(principal, { drafts })`, and into `toolsFor` and
`skillFor`, so the connection page and the SKILL.md list them. stdio builds
without them and never offers them. It is an argument, not a DI token:
`McpCoreModule` is shared with stdio and must not import collab.

**A key only ever narrows.** Scope and workspace pin live on the principal
(`principal.apiKey`) and are enforced inside `requireRole` — ahead of the
platform-admin shortcut, or an admin's read-only key would write anyway. Because
it is `requireRole`, every `@Access` REST route applies it too, without knowing
keys exist. Routes with no workspace to check (`POST /v1/workspaces`,
`PATCH /v1/me`) are covered by one rule in `AclGuard`: a read-only key gets no
non-GET method unless the route opts in with `@ReadKeyOk()` — which only
`POST /v1/mcp` does, because there POST is transport, not intent.

**Offer what can run.** A read-only key is not offered the write tools at all:
a tool that always 403s spends the model's context on a dead end. Offering is not
the check — each write tool still runs `requireRole`. `WRITE_TOOLS` is one closed
list that drives both that filter and MCP's `readOnlyHint` annotation, which is
what lets clients auto-approve reads and still ask before a write. A test fails
if the list names a tool that does not exist. The agent-memory tools are a
second closed list, `CAPTURE_TOOLS`, disjoint from `WRITE_TOOLS`. A capture key
is offered the reads plus that list, and they are the only calls that pass the
`{ capture: true }` flag which lifts such a key to editor.

**A capability is checked like a role.** Tools behind a member capability
(`api-test-suites.generate`, `api-test-suites.run`, #468/#483) pass it to their
`guard.*` call, the twin of the REST route's `@Access(…, { capability })`, and
whatever executes later checks it again. `knowledge_run_test_suite` sends
requests from the platform, so it is a write tool and a read-only key is not
offered it; the run plan (`knowledge_get_test_run_plan`) is the read-side way
for an agent to send with its own client. No tool hands out a test
environment's secret ([62](62-qa-fixtures-runs.md)).

**Toolsets.** Every tool is filed in one toolset, and the offer, the skill and
the server instructions are cut by toolset: by the key's own list and by the
sections its workspaces switched off. The skill can also be installed as a
stack of skills. All of it is in [78 — MCP toolsets](78-mcp-toolsets.md).

**Keys are managed from a session, never by a key.** Every `/v1/me/api-keys`
route refuses an API-key principal: a leaked key that could mint its own
replacement would survive being revoked.

**Attribution is the caller's.** Over HTTP every write — pages, revisions, merge
requests, approvals, comments, workflow starts — is recorded against the key's
owner, not the zeros stub. The merge gate therefore treats an agent's approval
as its owner's, and self-approval stays excluded.

**Still absent: running an agent, approving a workflow node.** Both would now
have a principal to attribute to, but the reasons they were left out were never
only attribution — an unattended AI run and a publish decision should begin
with a person. The two transports offer one tool set, so they are absent from
both.

**The skill is generated, not written.** The docs site already hands out a
skill for agents working _on_ this codebase. This one is for agents _using_ a
deployment, and what makes it useful is specific to the caller: the table of
workspace and project ids saves an agent its first three calls, and a read-only
key's skill must not describe an edit flow it cannot perform. It fetches with a
bearer header, so the install command can be re-run to pick up new workspaces.

**The capture kit is a reminder, not an agent.** The wizard's skill step runs
`curl -H "Authorization: Bearer …" $API_PUBLIC_URL/v1/mcp/capture-kit/install?client=… | sh`.
`GET /v1/mcp/capture-kit?client=` returns the same files as JSON
(`CaptureKitResponse`). The kit is a skill (Claude Code) or an agent-requested
rule (Cursor) carrying the capture playbook, plus a hook script that reminds
the model, once per session and only after it edited a file, to propose what
it learned. The script holds no key and calls nothing: the model captures
through the MCP server it is already connected to. Kits exist for
`claude-code` and `cursor` only (`CAPTURE_KIT_CLIENTS`); other clients get 400
and rely on the skill's "Capture memory" section. A credential offered no
capture tool gets 403 `capture-not-offered`. The installer never overwrites
`.claude/settings.json` or `.cursor/hooks.json`: it merges its entries with
`jq`, or prints them when `jq` is missing. The exact hook behaviour is in
[50 §The capture kit](50-agent-memory.md#the-capture-kit).

**Ticket context** ([81](81-ticket-context.md)). Since kit v3 the same hook
also nudges the model to call `knowledge_context` once per ticket it reads,
and the skill carries a "Starting a ticket" step for every other client. The
wizard shows that step, cut from the SKILL.md it fetched, when "Work on code" was chosen.

**Per-client snippets, not one JSON blob.** `apps/web/src/entities/access/model/mcp-clients.ts`
has a generator per client because the differences break connections, silently:
the env-var syntax differs in every client (`${VAR}`, `${env:VAR}`,
`{env:VAR}`, `$VAR`, a named TOML field) and a wrong one is sent literally;
Claude Code reads a `url` without `type` as stdio; Gemini reads `url` as SSE;
opencode tries OAuth unless told not to; Claude Desktop's config runs only local
servers (hence `mcp-remote`); VS Code currently sends `${env:}` in headers
literally (hence a prompted input); Zed has no env expansion at all. Added with
#1225: Qwen Code is a Gemini fork (`httpUrl`, `$VAR`); Kimi Code and pi name the
variable instead of expanding it (`bearerTokenEnvVar`, `--bearer-token-env-var`);
Oh My Pi wants `type: "http"` and the `~/.omp/agent/` path, not the older
`~/.omp/mcp.json`; Hermes Agent is YAML under `mcp_servers`; DeepSeek Harness is a
`@deepseek-ai/dsh-mcp-client` row in a Cordis patch layer whose header reads the
key through `!!js`. Their marks come from simple-icons (CC0) and are bundled in
`client-logos.ts`, so no reader's browser ever asks a vendor for a logo.

**The wizard asks, the plan decides** (#1225). Role → default workflows → the
narrowest key scope that does them all, and the toolsets they use: that mapping and
which steps apply (`key` only under `api-key`, `preferences` only when the client has a
skill directory or a capture kit was wanted) are pure functions in
`apps/web/src/entities/access/model/connect-plan.ts`, pinned by its spec. A derived
value is a default; a pick on a later step is an override that an earlier answer never
undoes. Limiting the key to the suggested toolsets stays opt-in, because a limited key
is MCP-only.

**Verify reads what the server already writes.** A key's `last_used_at` is set on its
first call (only later calls are throttled), so the last step polls the caller's own
`GET /v1/me/api-keys` every 3 s and says **Connected** the moment the client calls —
no new route, no recorded failures. With a key from before the wizard, it watches for
any key used after the wizard opened. After 90 s without a call (or on request) it
shows a `knowledge_whoami` curl and what each reply means (no reply, 401, 403, 404,
405, 200). Help text is static and translated; no model is asked.

**Single-key column kept, not read.** `users.api_key_hash` is superseded by
`api_keys` and the migration copies every value across. It is left in place so
the previous image still authenticates after a rollback — the contract step
drops it in a later release.

## Where it lives

| Piece                                                  | File                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| Tool set, guard, whoami, skill wiring                  | `apps/api/src/mcp/mcp.service.ts`                                           |
| Write list, annotations, read-key filter, instructions | `apps/api/src/mcp/mcp-tools.ts`                                             |
| SKILL.md renderer                                      | `apps/api/src/mcp/skill.ts`                                                 |
| HTTP transport + `/connection` + `/skill` + `/capture-kit` | `apps/api/src/mcp/mcp.controller.ts`                                    |
| Capture kit renderers + installer                      | `apps/api/src/mcp/capture-kit.ts`                                           |
| Draft tools (HTTP only)                                | `apps/api/src/mcp/draft-tools.ts`, `collab/collab-draft-tools.service.ts`   |
| Module split: core / stdio / HTTP                      | `mcp-core.module.ts`, `mcp.module.ts`, `mcp-http.module.ts`                 |
| Key narrowing                                          | `AccessService.requireKeyAllows`, `AclGuard` (read keys on unscoped routes) |
| Key resolution + `last_used_at`                        | `apps/api/src/auth/token-auth.service.ts`                                   |
| Key CRUD                                               | `apps/api/src/auth/api-keys.service.ts`, `MeController`                     |
| Client snippets                                        | `apps/web/src/entities/access/model/mcp-clients.ts`                                          |
| Manage page                                            | `apps/web/src/modules/access/pages/ConnectAiPage.vue`                                      |
| Setup wizard + its steps                               | `apps/web/src/modules/access/pages/ConnectWizardPage.vue`, `components/connect/`           |
| What the answers mean                                  | `apps/web/src/entities/access/model/connect-plan.ts`                                       |
| Tests                                                  | `apps/api/test/mcp-http.spec.ts`                                            |

## Configuration

`API_PUBLIC_URL` — already required for the GitHub App's OAuth callback — is now
also the base of the MCP URL every snippet contains (`$API_PUBLIC_URL/v1/mcp`).
Behind the production Caddyfile that is `https://<host>/api`.

## Not done

- **OAuth.** Clients that only speak OAuth for remote servers (Claude Desktop's
  native connectors, claude.ai) connect through `mcp-remote` for now. An OAuth
  authorization server would let them connect natively and is the obvious next
  step.
- **Per-tool key lists.** A key can be limited to chosen toolsets, and is then
  valid over MCP only ([78](78-mcp-toolsets.md)). A list finer than a toolset
  is not expressible.
- **Server push.** Stateless mode has no SSE stream, so no `tools/list_changed`
  notifications; clients see a new tool on reconnect.
