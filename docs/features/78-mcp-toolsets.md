# 78 — MCP toolsets: offer, narrow and describe tools by what a workspace uses

Milestone [#945](https://github.com/hrustalq/knowledge/issues/945), phases
[#948](https://github.com/hrustalq/knowledge/issues/948) (catalogue),
[#949](https://github.com/hrustalq/knowledge/issues/949) (offer by section),
[#950](https://github.com/hrustalq/knowledge/issues/950) (skill sections),
[#951](https://github.com/hrustalq/knowledge/issues/951) (instructions),
[#953](https://github.com/hrustalq/knowledge/issues/953) (key toolsets),
[#954](https://github.com/hrustalq/knowledge/issues/954) (Connect page),
[#955](https://github.com/hrustalq/knowledge/issues/955) (skill stack). It builds on
[33 — Connect AI](33-connect-ai.md) and [70 — Feature toggles](70-feature-toggles.md).

## What

An agent connected over MCP used to be offered all 93 `knowledge_*` tools whatever its
workspace used, with one skill and one set of instructions that described all of them. A
section a workspace had switched off still listed its tools, and they refused when called.

The rule now: **every tool belongs to exactly one toolset in a closed catalogue, and a
toolset is the unit that is offered, switched, narrowed and described.**

```
MCP_TOOLSETS (contracts)        one toolset per tool, an optional section per toolset
  → isOffered(tool, principal, offSections)      the one offer rule
      → settleTools      tools/list, GET /v1/mcp/connection
      → instructionsFor  the `initialize` instructions
      → skillSections    SKILL.md, the skill stack, knowledge://skill*
```

## The catalogue

`MCP_TOOLSETS` in `packages/contracts/src/identity/index.ts` files each tool under one of
20 keys. A toolset may name the `WorkspaceFeature` that switches it.

| Toolset | Section | Holds |
| --- | --- | --- |
| `core` | | whoami, search, the page tree and page reads, find similar, feedback, report issue |
| `authoring` | | pages, branches, revisions, uploads, ingest, templates, flag |
| `quality` | | lint a draft, a page's quality score |
| `review` | | the merge-request tools |
| `graph` | | relations, impact, paths, the workspace graph, history, release tags, graph query |
| `conflicts` | `conflicts` | list and resolve contradictions |
| `captures` | `captures` | `CAPTURE_TOOLS` and the capture list |
| `qa` | `qa` | test suites, fixtures and runs |
| `api-reference` | | API operations and spec diffs |
| `code` | | code usages, component drafts, the repo wiki |
| `connectors` | | connectors, sync runs, tracker work items |
| `workflows` | `workflows` | list, start, follow a run |
| `agents` | | agents and their learnings |
| `insights` | `analytics` | page insights, search gaps |
| `memos` | `memos` | list and read memos |
| `sharing` | | share links, exports, page access, access requests |
| `embeds` | | embedded designs |
| `chat` | | chat search |
| `projects` | | blueprints, project scaffolding |
| `drafts` | | the shared-draft tools (HTTP only, `COLLAB_ENABLED`) |

`FEATURE_TOOLS` and `featureOfTool` (`apps/api/src/mcp/mcp-tools.ts`) are derived from it,
so a tool joins a section by being filed in that section's toolset. A registered tool
filed nowhere fails `apps/api/test/mcp-http.spec.ts`, and `isOffered` does not offer it.
The registrar files in `apps/api/src/mcp/tools/` are not the grouping and were not moved.

## The offer

A tool is offered when `isOffered` passes three filters:

1. **The key's scope.** A read key keeps the reads, a capture key the reads and
   `CAPTURE_TOOLS` (unchanged, doc 33).
2. **The key's own toolset list**, when it has one (below).
3. **Its toolset's section is on somewhere.** `offSections` holds the sections that are
   off, or unavailable on this server, in **every** workspace the connection reaches.

### Several workspaces: the union

`tools/list` names no workspace, and a connection may reach several. So a section's
toolset is dropped only when the section is off everywhere the connection reaches; on in
one workspace is enough to offer it. This is exact for a key pinned to one workspace. A
connection that reaches no workspace is offered no section-tied toolset. stdio reaches
every workspace and uses the same rule, computed once at startup.

`McpService.sectionsOffFor` reads the reach (pinned key, dev or platform admin,
memberships; the same rule `whoami` uses) and asks `FeaturesService.offEverywhere`, one
`workspace_settings` query however many workspaces. `buildServer` stays synchronous: the
caller computes the set and passes it in `McpExtras.offSections`, as `instructions` is
passed. `McpController` computes it only for `initialize` and `tools/list`. A failed read
offers every section's tools.

### What stays a per-call check

Offer is never the check. `McpService.featureGate` runs before every call: it refuses a
tool outside the offer rule, then resolves the workspace the call names and answers 404
when that workspace has the section off, after the membership check. So a key that reaches
workspaces A (QA on) and B (QA off) lists the QA tools, and a QA call naming B is still a
404. Each handler's `guard.*` role check is unchanged.

A section switched off may stay listed for up to the 30 s features cache, and for as long
as a client keeps its own tool list. The transport is stateless, so there is no
`tools/list_changed`.

## Described as offered

- **Server instructions.** `mcpInstructions` composes the `initialize` text from the
  offered tools: a line renders only when the tools it names are offered. A caller offered
  everything receives the text as it was (`MCP_INSTRUCTIONS`). `McpService.instructionsFor`
  still appends the team guidance.
- **The skill.** `renderSkill` (`apps/api/src/mcp/skill.ts`) is a core (frontmatter,
  connection, access, rules, the tool table) around `skillSections`
  (`apps/api/src/mcp/skill-sections.ts`). Each playbook is a section filed under a
  toolset and renders only when its tools are offered; inside a section a step naming a
  tool renders only when that tool is offered. With every toolset offered the document is
  byte-identical to the one before the split (three snapshots pin it). The Git section
  follows `GIT_REMOTE_ENABLED` and drops when `git` is off in every reachable workspace.
- **A new playbook is a section**, never a block in the core template.

The tool table quotes each tool's registered description, which may name another tool.
The playbooks themselves name no tool the caller is not offered; a spec asserts it over
several tool lists.

## Keys limited to toolsets

`POST /v1/me/api-keys` takes `toolsets` (`api_keys.toolsets`, nullable Json). No list is
every toolset, which is every key that existed. `core` is always added. An unknown value
is a 400. A stored value the catalogue later drops reads as absent from the list, never as
"all" (`keyToolsetsOf`). A list is not editable: a key is replaced, as its scope is.

Over MCP such a key is offered only its toolsets, cut again by scope and section; the
skill, the instructions, `GET /v1/mcp/connection` and the capture kit follow, because all
read the same rule.

**A key with a list is MCP-only.** A handler calls services directly, so a list enforced
only inside MCP would leave the same key free to read and write everything over REST. The
refusal is in `TokenAuthService.resolve` (`apps/api/src/auth/token-auth.service.ts`),
where every door resolves its bearer: a key with a list is a 403 `apiKeyMcpOnly` unless
the caller passes `{ mcp: true }`. Only `AuthGuard` does, for a route marked `@McpKeyOk()`,
which is `McpController` as a whole: `/v1/mcp`, `/connection`, `/skill`, `/skills*` and
`/capture-kit*`. REST routes, the git remote, the live socket and the plain-markdown URLs
resolve without it and are closed, and so is any door added later.

## The Connect page

`GET /v1/mcp/connection` returns `toolset` on every tool and `notOffered`, the toolsets
the caller is offered nothing of, each with a reason: `section-off` or `key-toolsets`. A
key's scope hides single write tools, never a whole toolset, so it is not a reason.

`apps/web/src/modules/access/pages/ConnectAiPage.vue` groups the tools by toolset with
read and write counts, keeps a row with the reason for a toolset that is not offered, and
marks a section that is off in the current workspace but offered through another. The key
form has a toolset picker, closed until asked for: untouched sends no `toolsets`, and any
choice states that the key will work over MCP only before it is created. Labels are
`connect.toolsets.*`; a spec requires an en and a ru label for every catalogue key.

## The skill stack

A client loads a skill by its description, so one skill puts the whole document in the
context whenever any part is relevant. `renderSkillStack` cuts the same sections into a
core skill (`knowledge-core`: connection, access, the answer playbook, rules, and the
names of the others) and one `knowledge-<toolset>` skill per offered toolset that has a
playbook (`TOOLSET_SKILLS`), each with a description that says when to load it. Every
section of the one document is in exactly one stack skill; a spec asserts it.

| Surface | What it serves |
| --- | --- |
| `GET /v1/mcp/skills?dir=claude\|agents` | the stack as files (`SkillStackResponse`) |
| `GET /v1/mcp/skills/install?dir=` | the same files as a POSIX shell script |
| `knowledge://skills/<name>` | each stack skill as an MCP resource, listed only when offered |

The installer writes one folder per skill under the client's skills directory
(`SKILL_DIRS`; `KNOWLEDGE_SKILLS_DIR` overrides it). Every stack skill carries a marker
line. A re-run replaces a folder that holds the marker, removes a `knowledge-*` folder
that holds it and is no longer in the stack, and leaves alone, with a message, a folder
of the same name that it did not write.

`GET /v1/mcp/skill`, `knowledge://skill` and the `guide` prompt are unchanged and remain
the default; the Connect page offers the stack beside the one-file install for a client
with a skills directory.

## Where it lives

| Piece | File |
| --- | --- |
| Catalogue, `toolsetOf`, `keyToolsetsOf`, `SKILL_DIRS` | `packages/contracts/src/identity/index.ts` |
| Offer rule, instructions, `toolsetsNotOffered` | `apps/api/src/mcp/mcp-tools.ts` |
| Reach, `sectionsOffFor`, the call gate, stack wiring | `apps/api/src/mcp/mcp.service.ts` |
| Batched section read | `apps/api/src/auth/features.service.ts` |
| Skill core, stack and installer | `apps/api/src/mcp/skill.ts` |
| Skill sections, `TOOLSET_SKILLS` | `apps/api/src/mcp/skill-sections.ts` |
| Stack resources | `apps/api/src/mcp/tools/resources.ts` |
| Routes | `apps/api/src/mcp/mcp.controller.ts` |
| MCP-only refusal | `apps/api/src/auth/token-auth.service.ts`, `apps/api/src/auth/auth.guard.ts` |
| Key toolsets | `apps/api/src/auth/api-keys.service.ts`, `apps/api/src/auth/api-keys.dto.ts` |
| Page, install commands | `apps/web/src/modules/access/pages/ConnectAiPage.vue`, `apps/web/src/entities/access/model/mcp-clients.ts` |
| Tests | `apps/api/test/mcp-http.spec.ts` |

## Not built

- Offering by data (no connector, so no connector tools).
- A `?toolsets=` parameter on the MCP URL, and per-tool lists finer than a toolset.
- Editing a key's toolsets, and a workspace default or ceiling for them.
- New workspace sections for connectors, the API reference or embeds.
- A tool-search meta-tool, and `tools/list_changed`.
- A hook or any automatic update of an installed stack: re-running the installer is the
  update. The capture kit's hook stays its own install.
- Stopping a section's background work; doc 70's decision stands.
