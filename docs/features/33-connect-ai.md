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
  for Claude Code, Cursor and Codex, the capture kit, below), and ends by **waiting for the
  key's first call**. Every step carries a "Something not working?" panel: symptom →
  fix, for the step and for the chosen client.
- **Settings → AI → Connect AI** (`/settings/ai/connect`; it was its own settings row
  at `/settings/connect` until issue #182, and that URL — printed in every SKILL.md
  already handed out — redirects) is the manage side: the endpoint, your keys (revoke,
  last used, captures), the skill commands, the offered tools and the llms.txt URLs.
  `?client=` on either URL opens the wizard on that client.
  The skill commands (#1343) are the wizard's own, chosen by skills directory instead of
  by client (`skillDirGuides` groups the client table by `skillDir`): the single
  `SKILL.md`, the stack where the server has one for that directory, and the capture kit
  for a client that has one, only while the caller is offered a capture tool. They read
  the key from `$KNOWLEDGE_API_KEY`; the page never shows or mints one. A client with no
  skills directory is not listed here and loads `knowledge://skill`.
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
(`CaptureKitResponse`). The kit is a skill (Claude Code, Codex) or an agent-requested
rule (Cursor) carrying the capture playbook, plus a hook script that reminds
the model, once per session and only after it edited a file, to propose what
it learned. The script holds no key and calls nothing: the model captures
through the MCP server it is already connected to. Kits exist for
`claude-code`, `cursor` and `codex` only (`CAPTURE_KIT_CLIENTS`); other clients get 400
and rely on the skill's "Capture memory" section. A credential offered no
capture tool gets 403 `capture-not-offered`. The installer never overwrites
`.claude/settings.json`, `.cursor/hooks.json` or `.codex/hooks.json`: it merges its entries with
`jq`, or prints them when `jq` is missing. Codex's hook file is JSON even though its
config is TOML (#1350). Codex skips a hook until the person trusts it in `/hooks`, and the installer says so. The exact hook behaviour is in
[50 §The capture kit](50-agent-memory.md#the-capture-kit).

**One setup command** (#1347). `GET /v1/mcp/setup/install?client=<id>` returns
one POSIX script for a client in the table: it registers the server, installs the
skill and, inside a git repository, the capture kit. It composes the two installers
above, each in its own subshell, rather than restating them
(`apps/api/src/mcp/setup.ts`); `skill=single` and `kit=no` carry the wizard's
answers, and an unknown client is 400 `setup-client`. The script refuses to start,
before writing anything, when the server takes keys and `KNOWLEDGE_API_KEY` is
empty. It reads the whole body into a function before running, so a command that
reads stdin cannot swallow the rest of a `curl | sh`, and it never prints the key
(`set +x`; `claude mcp get` output goes only to `grep`).

- **Register.** A vendor CLI is run only where the script can ask it whether the
  server is already there, which today is Claude Code (`claude mcp get <name>`
  printing the same URL means unchanged; another URL is left as it is and the
  person is told how to replace it). Every other CLI command, and every config
  file, is printed with the file it belongs in. The script never edits a
  user-level config it did not write. A check for another CLI belongs in
  `registerCheck` once someone has run that CLI ([§Client checks](#client-checks)).
- **Skill.** The stack where the client's skills directory has one
  (`~/.claude/skills`, `~/.agents/skills`), else one `SKILL.md`, else a line
  saying the client reads none.
- **Kit.** Only when the client has a kit and the caller is offered a capture
  tool, the same predicate the kit route's 403 reads. A read key's script has no
  kit step. Outside a git repository the step is skipped with a reason and the
  exit code stays 0.

**For a repository** (#1348). `scope=project` writes the client's project-level config
into the git repository the script runs in (it `cd`s to the top level and refuses
outside one, before writing anything) instead of registering per user. Each client's
`projectConfig` in the contracts table is either `{ path, code, docs }` or
`{ refused }`. A client gets a path where its vendor's docs or source show both a
project-level file and an env reference for the key there, and that file is the
same JSON as its user-level config, so the key is always `KNOWLEDGE_API_KEY` in the
client's own syntax:

| Client | Project file | Key reference |
| --- | --- | --- |
| Claude Code | `.mcp.json` | `${KNOWLEDGE_API_KEY}` in `headers` (a custom name: Claude Code blanks only its own, cloud and a fixed set of named credentials in remote headers) |
| Cursor | `.cursor/mcp.json` | `${env:KNOWLEDGE_API_KEY}` |
| Kimi Code | `.kimi-code/mcp.json` | `bearerTokenEnvVar` |
| pi | `.pi/mcp.json` | `${KNOWLEDGE_API_KEY}` |
| Oh My Pi | `.omp/mcp.json` | `${KNOWLEDGE_API_KEY}` |
| Gemini CLI | `.gemini/settings.json` | `$KNOWLEDGE_API_KEY` in `headers` (only in a trusted folder; an untrusted one drops every server) |
| Qwen Code | `.qwen/settings.json` | `$KNOWLEDGE_API_KEY` in `headers` (only in a trusted folder; approve once with `qwen mcp approve knowledge`, and the approval binds to that config) |
| opencode | `opencode.json` | `{env:KNOWLEDGE_API_KEY}` (the V1 `mcp.<name>` shape: 1.x rejects V2's `mcp.servers`, 2.x still reads V1) |

Every other client is 400 `setup-project-unsupported` with `refused`:
`no-env-in-headers` (VS Code, Zed, Devin/Windsurf) or `no-project-config`
(Codex's project file is TOML, which the `jq` merge cannot handle; Claude Desktop,
Hermes, DeepSeek Harness, the raw HTTP entry). It is never given the per-user
setup in its place. An unknown scope is 400 `setup-scope`.

Gemini CLI and Qwen Code qualify on their source, not their docs (#1364): Gemini
runs every MCP header value through `expandEnvVars` (`packages/core/src/tools/mcp-client.ts`)
and merges a workspace settings file only when the folder is trusted
(`packages/cli/src/config/settings.ts`); Qwen runs `resolveEnvVarsInObject` over the
whole workspace settings object before the merge (`packages/cli/src/config/settings.ts`).
Neither vendor documents expansion in MCP headers, so `projectConfig.docs` cites those
lines instead of a docs page.

The file is created when absent; when present, `jq` merges it one level deep, so
every other server and top-level setting is kept and this server's entry is replaced
whole; without `jq`, or for a file that is not JSON, the entry is printed to merge by
hand (the capture kit's rule). The skill step still installs per caller, and says
so: it is generated for each key. The script ends with the files to commit (the
config plus the capture kit's files). The spec renders every project config and
project script with a real-looking key in the input and asserts it appears in
neither. A trust or approval step comes first in five clients: Claude Code shows the
server as "Pending approval" until someone runs `claude` in the folder and approves it;
Kimi skips it until the folder is trusted; pi ignores `.pi/mcp.json` until the project is
trusted; Gemini CLI does not read a workspace settings file in an untrusted folder; and
Qwen Code skips MCP connections there and asks to approve its project server once
(`qwen mcp approve knowledge`), binding the approval to that config, so a changed key
returns it to Pending. Run live in #1351: Claude Code, pi, Oh My Pi and opencode connect
from their project file once approved or trusted; Gemini CLI and Qwen Code connected from
theirs once trusted or approved (#1364); Cursor's is not run ([§Client checks](#client-checks)).
The UI says a client may ask to approve or trust the repository's server first.

Every installer writes a file through one `put` helper (`PUT_FN`, `apps/api/src/mcp/installer-shell.ts`)
that compares first, so a second run reports `unchanged` for each step. The
wizard's skill step and the manage page lead with this command and keep the
separate commands behind a disclosure.

**Ticket context** ([81](81-ticket-context.md)). Since kit v3 the same hook
also nudges the model to call `knowledge_context` once per ticket it reads,
and the skill carries a "Starting a ticket" step for every other client. The
wizard shows that step, cut from the SKILL.md it fetched, when "Work on code" was chosen.

Most clients load a skill's description and the server instructions, never the skill body, so the step alone
reached no model without a hook (#1362). Where `knowledge_context` is offered, the rule is also in both places a
model reads first: the `knowledge-core` description adds "or when starting work on a ticket or issue in a
repository", and the server instructions add a line that names `knowledge_context`, with `repo` from
`git remote get-url origin`. A caller not offered the tool gets neither. The core's connection line tells a model
whose client loads tools on demand (Hermes, pi) to search for `knowledge` before it calls the server not connected.
pi's snippet marks `knowledge_whoami` and `knowledge_context` `toolExposure: "direct"`, which `pi mcp add` cannot set.

**Per-client snippets, not one JSON blob.** `packages/contracts/src/clients/index.ts`
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

## OAuth for MCP clients (#1352)

A client that speaks the MCP authorization flow connects to `/v1/mcp` by signing
the person in through the browser: no key minted by hand, no `mcp-remote`. The
design was agreed on #1352 before any code; this is what shipped.

- **Spec.** Built to the 2025-11-25 authorization spec (what Claude implements:
  2025-03-26, 2025-06-18, 2025-11-25) and complete for 2026-07-28, which only
  deprecates dynamic registration. Protected-resource metadata (RFC 9728),
  authorization-server metadata (RFC 8414), PKCE S256 only, Client ID Metadata
  Documents (CIMD), dynamic registration (RFC 7591), refresh rotation,
  revocation (RFC 7009).
- **A grant is an `api_keys` row.** The consent screen writes it through
  `ApiKeysService.createGrant` with the key form's checks, cap and audit
  (`oauth.granted`), plus `oauth_client_id` and the approving session's sign-in
  method and provider. It has no bearer of its own (`key_hash` is null). Its
  tokens live in `oauth_tokens`, hashed: `ko_` access (1 h, never past the
  grant) and `kor_` refresh (rotated on every use; a spent one presented again
  ends the grant, as does a replayed code). `TokenAuthService.resolveOAuth`
  turns a `ko_` token into the same `principal.apiKey` the row would give as a
  key, with `oauth` added. So `requireRole` narrowing, toolsets, `isOffered`,
  audit, `isCurrent` and revocation (`DELETE /v1/me/api-keys/:id`, the same
  button on this page) all apply unchanged.
- **Audience.** A `ko_` token is MCP-only by the same rule as a toolset-limited
  key: refused wherever `@McpKeyOk` is not said, which today is everything but
  `McpController`.
- **Enforced SSO judges the sign-in, not the key.** `policyFailure` sends an
  OAuth principal down the session branch, so `allowApiKeys` never lets a
  password sign-in through. A grant from another IdP is `foreign-provider`, and
  the workspace age cap counts from consent. Approving with a workspace pin asks
  `requireRole` first, so the screen refuses before a grant exists.
- **A token never makes or extends a grant.** Approving is `@SessionOnly` and
  `createGrant` requires a `ks_` session. A grant ends a fixed time after
  consent (chosen on the screen, 90 days by default), and refreshing never
  moves that date.
- **The protocol is the MCP SDK's** (`@modelcontextprotocol/sdk/server/auth`
  handlers): redirect matching (exact, loopback port relaxed per RFC 8252), PKCE
  verification, error shapes. `OAuthService` implements its
  `OAuthServerProvider` for storage and decisions. `mount.ts` puts the handlers
  on the API's Express instance, with the house Redis limiter in place of the
  SDK's in-memory one. The SDK's `mcpAuthRouter` is not used: its metadata
  cannot advertise CIMD.
- **CIMD** is resolved inside `getClient`. An `https` client id with a path is
  fetched through `safeFetch` (5 KB, 5 s, no redirects). The document must name
  itself, list redirect URIs and be a public client. It is cached in
  `oauth_clients` for its `max-age` (24 h at most), and a stale copy serves while
  the client's host is down. Checked against Claude Code's real document
  (`https://claude.ai/oauth/claude-code-client-metadata`).
- **Dynamic registration is an unauthenticated write.** It is held to 20 per IP
  per hour (fails closed without Redis), and a client is always registered
  public. Never-granted registrations are pruned after 24 h, and over 1 000 of
  them answers `temporarily_unavailable`.
- **Discovery.** The issuer is `API_PUBLIC_URL`'s origin, so the documents are
  at `/.well-known/oauth-protected-resource/<api path>/v1/mcp` and
  `/.well-known/oauth-authorization-server`, and the proxy sends `/.well-known/oauth-*`
  to the API (Caddyfile). The endpoints are `$API_PUBLIC_URL/oauth/{authorize,token,register,revoke}`.
  A 401 from the MCP controller carries
  `WWW-Authenticate: Bearer resource_metadata="…"`, and Claude honours that
  pointer only on a 401.
- **Consent screen.** `/oauth/authorize?request=` in the member app (`meta.focus`).
  Signed out, it goes to `/login` first. It shows the client's name, who vouches
  for it (a CIMD domain, or a warning that a registered name is unverified) and
  where the browser returns, then offers the key form's access, workspace,
  expiry and toolset choices. The request lasts 10 minutes and the code 2.
- **Wizard (#1371).** With OAuth on, `McpConnectionInfo.oauth` is true and the
  key step first asks a client that can sign in how it will: *In the browser*
  (the default) or *With an API key*. "Can sign in" is `McpClientGuide.signIn`,
  set for the 13 clients whose vendor docs describe MCP OAuth for a remote HTTP
  server (checked 2026-11-20): every client but DeepSeek Harness and the generic
  HTTP entry. `mcpClients({ signIn: 'oauth' })` renders those with no
  credential (an `Authorization` header turns OAuth off in all of them), marks
  them `oauth`, and keeps the key snippet for the rest. Three need more than
  "no header": Hermes adds `auth: oauth`, opencode drops `oauth: false`, Claude
  Desktop becomes a custom connector instead of `mcp-remote`. `signIn.command`
  is the client's own sign-in step (`codex mcp login knowledge`, `/mcp`, …), or
  null where the client asks by itself on its first connection. Each client
  also has an OAuth note (`connect.clients.oauthNotes`), since the key notes
  would mislead.
- **Setup key (#1371).** The installer curls still need a credential when the
  client does not, so on reaching the skill step the wizard mints a setup key:
  `POST /v1/me/api-keys { install: true }` → `api_keys.purpose = 'install'`,
  `expires_at` = now + `INSTALL_KEY_TTL_MINUTES` (60), scope from the workflows
  (the skill describes the credential that fetched it, and a read key is
  refused the kit), refused together with `expiresInDays`.
  `TokenAuthService.resolve` refuses it at every door unless the route says
  `install`, which only the six installer handlers (`@InstallKeyOk`, per
  handler, never the class) do: `skill`, `skills`, `skills/install`,
  `setup/install`, `capture-kit`, `capture-kit/install`. `POST /v1/mcp`, REST, the
  git remote and the live socket all answer 403 `apiKeyInstallOnly`. A spent
  setup key drops out of the key list and the 50-key cap; an ordinary expired
  key stays listed, as before. `setup/install?signIn=oauth` registers with no
  credential, skips the `KNOWLEDGE_API_KEY` check and prints the sign-in step;
  it is 400 `setup-sign-in-off` while OAuth is off.
- **Verify (#1371).** A browser sign-in is connected once a grant (`oauth`)
  created after the wizard opened has been used. The setup key never counts,
  and there is no terminal check to offer: after 90 s the step says how to
  start the client's sign-in by hand.
- **Stateless HTTP stays.** Each `/v1/mcp` call resolves its bearer like a key
  does. Nothing about the transport keeps state.

Not done: a project pin on the consent screen (keys only), OAuth for the
memory-bank MCP and REST, and checking clients other than Claude live.

## Where it lives

| Piece                                                  | File                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| Tool set, guard, whoami, skill wiring                  | `apps/api/src/mcp/mcp.service.ts`                                           |
| Write list, annotations, read-key filter, instructions | `apps/api/src/mcp/mcp-tools.ts`                                             |
| SKILL.md renderer                                      | `apps/api/src/mcp/skill.ts`                                                 |
| HTTP transport + `/connection` + `/skill` + `/capture-kit` + `/setup/install` | `apps/api/src/mcp/mcp.controller.ts`                    |
| One setup command: register step + composed installers | `apps/api/src/mcp/setup.ts`                                                 |
| Capture kit renderers + installer                      | `apps/api/src/mcp/capture-kit.ts`                                           |
| Draft tools (HTTP only)                                | `apps/api/src/mcp/draft-tools.ts`, `collab/collab-draft-tools.service.ts`   |
| Module split: core / stdio / HTTP                      | `mcp-core.module.ts`, `mcp.module.ts`, `mcp-http.module.ts`                 |
| Key narrowing                                          | `AccessService.requireKeyAllows`, `AclGuard` (read keys on unscoped routes) |
| Key resolution + `last_used_at`                        | `apps/api/src/auth/token-auth.service.ts`                                   |
| Key CRUD                                               | `apps/api/src/auth/api-keys.service.ts`, `MeController`                     |
| Client snippets                                        | `packages/contracts/src/clients/index.ts`                                          |
| Manage page                                            | `apps/web/src/modules/access/pages/ConnectAiPage.vue`                                      |
| Setup wizard + its steps                               | `apps/web/src/modules/access/pages/ConnectWizardPage.vue`, `components/connect/`           |
| What the answers mean                                  | `apps/web/src/entities/access/model/connect-plan.ts`                                       |
| OAuth: protocol mount, provider, consent API           | `apps/api/src/oauth/` (`mount.ts`, `oauth.service.ts`, `oauth.controller.ts`) |
| OAuth: token resolution, URLs, SSO rule                | `token-auth.service.ts`, `auth/oauth-urls.ts`, `policyFailure`              |
| OAuth consent screen                                   | `apps/web/src/modules/access/pages/OAuthConsentPage.vue`                    |
| Tests                                                  | `apps/api/test/mcp-http.spec.ts`, `apps/api/test/mcp-oauth.spec.ts`         |

## Configuration

`API_PUBLIC_URL` — already required for the GitHub App's OAuth callback — is now
also the base of the MCP URL every snippet contains (`$API_PUBLIC_URL/v1/mcp`).
Behind the production Caddyfile that is `https://<host>/api`.

`MCP_OAUTH_ENABLED` (default `false`, needs `AUTH_MODE=api-key`) turns on OAuth
for MCP clients. It is a ceiling: off means the discovery documents and
endpoints 404, a 401 carries no pointer, and existing grants stop resolving.

## Client checks

Each client is driven against production with what the wizard hands out, pasted as is (#1209, #1351): the one setup
command (`/v1/mcp/setup/install?client=<id>`, and `&scope=project` where the client has a project file), and whatever
config or command it prints, applied unedited. A row records the version checked and five cases:

- **Connect:** the pasted config lists the knowledge tools and `knowledge_whoami` answers.
- **Skill:** the client loads the generated skill (the stack in `~/.claude/skills` / `~/.agents/skills`, else the one
  SKILL.md).
- **Ticket first:** given a ticket, the first content call is `knowledge_context`, with `repo` set from
  `git remote get-url origin`.
- **Hook nudge** (only `CAPTURE_KIT_CLIENTS`): one nudge per ticket, none for a second read of the same ticket, a new
  one for a new ticket, and both tickets of `gh issue view 1; gh issue view 2` in one command.
- **Capture:** a session that settled something proposes a `knowledge_capture_*` that becomes a merge request.

Last run: prod **v0.62.0**, 2026-11-20 (Kimi Code: v0.61.0, the same day). Every client ran headless in its own
throwaway `HOME`, in a fixture repository with an scp-style `origin` and a fake `gh` printing two tickets. Models:
Claude Code on Haiku; every other client on DeepSeek (`deepseek-flash`) through its own provider settings. The key was
pinned to a real workspace, so Capture ran only where noted, and each merge request it opened was closed at once.

The Ticket first failures marked #1362 ran before the rule reached the skill description and the server instructions
(see Ticket context above). Those rows are re-run on the release that ships the change.

| Client                 | Version    | Connect                    | Skill    | Ticket first                     | Hook nudge          | Capture            |
| ---------------------- | ---------- | -------------------------- | -------- | -------------------------------- | ------------------- | ------------------ |
| Claude Code            | 2.1.329    | pass ¹                     | pass     | pass                             | pass ²              | pass on v0.61.0; not re-run, #1363 |
| Codex                  | 0.171.0    | pass                       | pass     | pass with the kit; fail without, #1362 | pass ³        | not run #1363      |
| DeepSeek Harness       | 0.2.2-rc.5 | pass ⁴                     | pass ⁵   | pass                             | n/a (no hook)       | pass               |
| opencode               | 1.14.48    | pass ⁶                     | pass     | pass                             | n/a (no hook)       | not run #1363      |
| Oh My Pi               | 16.3.0     | pass, from the second session, #1365 | pass | pass                       | n/a (no hook)       | not run #1363      |
| pi                     | 1.6.0      | pass                       | pass ⁵   | fail #1362 ⁷                     | n/a (no hook)       | not run #1363      |
| Gemini CLI             | 0.70.0     | pass ⁸                     | pass     | fail #1362 (no `repo`)           | n/a (no hook)       | not run #1363      |
| Qwen Code              | 0.28.0     | pass                       | pass     | fail #1362                       | n/a (no hook)       | not run #1363      |
| Hermes Agent           | 0.19.0     | pass with the `mcp` extra, #1365 | pass | fail #1362, #1365              | n/a (no hook)       | not run #1363      |
| Kimi Code              | 2.6.3      | pass ⁹                     | pass     | fail #1341                       | n/a (no hook)       | fail #1341         |
| Cursor                 | —          | not run: needs a GUI, #1363 | not run | not run                          | not run             | not run            |
| VS Code, Claude Desktop, Windsurf, Zed | — | not run: needs a GUI, #1363 | not run | not run                  | n/a (no hook)       | not run            |
| Any MCP client (curl)  | —          | pass                       | n/a      | n/a                              | n/a (no hook)       | n/a                |

Fixed in the same pull request as this table (#1351): the stack skills' `description` was unquoted, so `knowledge-qa`
(whose description holds ": ") was dropped as invalid YAML by pi and DeepSeek Harness; the setup script stopped with
`DSH_HOME: unbound variable` before printing DeepSeek Harness's row; DeepSeek Harness reads `~/.agents/skills` and now
gets the stack; opencode gets `opencode.json` as its project file.

¹ The setup command registers the server, and a second run says `unchanged` for every step. The project setup's `jq`
merge kept another server and an extra top-level key, and replaced a stale `knowledge` entry whole. An unapproved
project `.mcp.json` server is hidden behind a user-scope server of the same name (no "Pending approval" hint), which
the wizard's note now says.

² Kit v5: one nudge for 4821, none for re-reading it, a new one for 4822 (and `knowledge_context` then sent `exclude`),
and `gh issue view 4821; gh issue view 4822` in one Bash call nudged once for both — #1340 is fixed.

³ The same four steps pass in Codex once the hooks run. Codex loads `.codex/hooks.json` only in a trusted project and
runs each hook only after it is trusted in `/hooks`, which records a hash per hooks.json entry under the checkout's
absolute path in the user's `config.toml` — so a moved or re-cloned repository needs trusting again. Headless, the
check trusted them through `codex app-server` (`hooks/list` + `config/batchWrite`), the writer `/hooks` uses. On DeepSeek the hook turns ran through a local proxy that moves the hook's
message after the tool output, because DeepSeek refuses Codex's order (#1365). Without the kit the model never opened
the skill (#1362).

⁴ The printed `cordis.patch.yml` row validates against `dsh --dump-config-schema` and composes after the headless
profile.

⁵ After the quoting fix above; before it, 11 of the 12 stack skills loaded.

⁶ opencode 1.14.48 rejects the V2 `mcp.servers` shape and opencode 2.x still reads V1, so the snippet's `mcp.<name>`
shape is the one both accept (#1357). The same JSON in a repository's `opencode.json` connects.

⁷ pi hides MCP tool descriptions behind its tool search; marking `knowledge_whoami` and `knowledge_context`
`toolExposure: "direct"` made one rerun pass (#1362).

⁸ Gemini CLI disables every MCP server, user-level ones too, in an untrusted folder. Its model cases ran through a
local Gemini-to-DeepSeek API shim, not a Google sign-in (#1363).

⁹ The pasted `.kimi-code/mcp.json` connects and Kimi discovers all 94 tools, but only once the folder is trusted
("Trust this folder" or `KIMI_CODE_TRUST_WORKSPACE=1`); an untrusted folder skips a project-level server with a
warning. The model's tool list then held no MCP tools at all, headless (`kimi -p`) or over ACP, so it reported the
server as not connected. #1341 tracks the cause.

The wizard's "Context when a ticket starts" block was checked on the Skill step in en and ru (Claude Code, "I build
software").

## Not done

- **Per-tool key lists.** A key can be limited to chosen toolsets, and is then
  valid over MCP only ([78](78-mcp-toolsets.md)). A list finer than a toolset
  is not expressible.
- **Server push.** Stateless mode has no SSE stream, so no `tools/list_changed`
  notifications; clients see a new tool on reconnect.
