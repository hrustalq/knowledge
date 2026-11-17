# 82 — Methodologies: live blueprints with levels, workflows and agents

Milestone [#1121](https://github.com/hrustalq/knowledge/issues/1121). It builds on
[73 — Project scaffolding](73-project-scaffolding.md) (blueprints), [42 — Page templates](42-page-templates.md),
[17 — Workflows](17-workflows.md), [20 — Agents](20-agents.md), [53 — Doc quality](53-doc-quality.md) (styleguides),
[14 — Glossary](14-glossary.md) and [76 — Project settings](76-project-settings.md).

| Phase | Issue | PR | What landed |
| --- | --- | --- | --- |
| 0 | [#1122] | [#1229] | `levels`, `workflows`, `agents` in the `Blueprint` contract and its parse; no behaviour change |
| 1 | [#1123] | [#1230] | `projects.blueprint_id`; the methodology scope for templates and workflows |
| 2 | [#1124] | [#1231] | The methodology scope for styleguides and glossary terms; materialization on save |
| 3 | [#1125] | [#1232] | Link, switch and archive from Project settings; scaffolding links |
| 4 | [#1126] | [#1233] | Derived page levels on documents and search; the level prior |
| 5 | [#1127] | [#1234] | Methodology agents; model tiers |
| 6 | [#1128] | [#1259] | The level picker in the chat composer |
| 7 | [#1129] | [#1261] | Built-in Knowledge-Driven Construction; levels for Discovery-first; four templates |
| 8 | [#1130] | — | This doc |

[#1122]: https://github.com/hrustalq/knowledge/issues/1122
[#1123]: https://github.com/hrustalq/knowledge/issues/1123
[#1124]: https://github.com/hrustalq/knowledge/issues/1124
[#1125]: https://github.com/hrustalq/knowledge/issues/1125
[#1126]: https://github.com/hrustalq/knowledge/issues/1126
[#1127]: https://github.com/hrustalq/knowledge/issues/1127
[#1128]: https://github.com/hrustalq/knowledge/issues/1128
[#1129]: https://github.com/hrustalq/knowledge/issues/1129
[#1130]: https://github.com/hrustalq/knowledge/issues/1130
[#1229]: https://github.com/hrustalq/knowledge/pull/1229
[#1230]: https://github.com/hrustalq/knowledge/pull/1230
[#1231]: https://github.com/hrustalq/knowledge/pull/1231
[#1232]: https://github.com/hrustalq/knowledge/pull/1232
[#1233]: https://github.com/hrustalq/knowledge/pull/1233
[#1234]: https://github.com/hrustalq/knowledge/pull/1234
[#1259]: https://github.com/hrustalq/knowledge/pull/1259
[#1261]: https://github.com/hrustalq/knowledge/pull/1261

## What

Before this, a blueprint was copied once. Scaffolding wrote its conventions into rows the new project owned, and then
nothing linked the two: improving the blueprint changed no project, and a blueprint knew nothing about workflows,
agents or the stages a team works through.

The rule: **a methodology is data that the existing primitives read; a page's level is derived from its template
through the project's methodology and never stored; every new field is a sparse override whose empty value reproduces
the previous behaviour exactly.** A project with no methodology lists the same templates, workflows, styleguide,
glossary and agents as before, and its chat sends the same prompt.

```
project_blueprints (+ versions)  ── the methodology: tree, conventions, levels, workflows, agents
        ▲  projects.blueprint_id (live, nullable, no FK)
        │
project ─┼─ templates / workflows / styleguide / glossary: project → methodology → workspace
        ├─ agents: rows the methodology owns, keyed apart (`ownedAgentKey`)
        └─ pages:  level = levelOf(page.template_ref, methodology.levels) — read time only
                        ├─ on GET /v1/documents/:id and on search results
                        ├─ the search prior (SearchDto.level)
                        └─ the chat level picker → default agent + guidance + prior
```

## The shape

A methodology is a `Blueprint` (`@knowledge/contracts/blueprints`) with any of three optional fields. `isMethodology`
is true when one of them is non-empty; the UI says "methodology" for those and "blueprint" for the rest. There is no
methodology table.

- `levels: BlueprintLevel[]`, in order: `key` (slug), localized `name` and `description`, the `templateRefs` it
  covers, an optional `agentKey` (a built-in agent key or one of the blueprint's `agents`), and localized
  `guidance`. Guidance is trusted prompt text, so only a workspace admin may write it, the styleguide rule.
- `workflows: BlueprintWorkflow[]`: a name, a description, a `WorkflowGraph` and a trigger.
- `agents: BlueprintAgent[]`: a key (never a built-in agent's), name, description, instructions, tools from
  `ASSISTANT_TOOL_NAMES` only (a methodology cannot know which MCP plugins a workspace has) and an optional `minTier`.

The one parse is still `parseBlueprint` (`apps/api/src/blueprints/blueprint.schema.ts`). It checks level keys, workflow
names and agent keys for duplicates, runs every workflow graph through `validateGraph`, and refuses a level whose
`agentKey` names an agent nobody declared. Caps: `BLUEPRINT_MAX_LEVELS`, `BLUEPRINT_MAX_WORKFLOWS`,
`BLUEPRINT_MAX_AGENTS` (20 each), `BLUEPRINT_LEVEL_GUIDANCE_MAX` (4,000 characters per language).

## The live link

`projects.blueprint_id` is nullable, with no FK (house style), and is read in exactly one place: `projectScope` in
`apps/api/src/projects/methodology-scope.ts`. Null behaves exactly as before the milestone.

**Resolution order: the project's own row, then the methodology's, then the workspace's.** Tables that can hold a
methodology's rows (`page_templates`, `workflow_definitions`, `ai_skills`, `glossary_terms`, `ai_agents`) gained a
nullable `blueprint_id`. Two helpers beside `projectScope` are what every listing uses:

- `scopeWhere(scope)`: the Prisma filter for project rows, the methodology's rows and workspace-wide rows. Without a
  project, the workspace listing: every row no methodology owns.
- `shadowByScope(rows)`: drops a row shadowed by a nearer one of the same name, case-insensitively: a methodology row
  under a project row, a workspace row under a methodology row. Only a clash with a methodology row shadows anything,
  so a project without a methodology lists what it always did.

Callers today: `TemplatesService`, `WorkflowsService` and `WorkflowTriggerService`, `AiSkillsService` (styleguides)
`GlossaryService`, and `CaptureService` (the glossary a capture checks against). A new listing of any of these tables goes through the same helpers.

**Switching** changes `blueprint_id` and nothing else, so levels re-derive at once. The page tree is never rewritten
automatically. `GET /v1/projects/:id/methodology/preview` lists the sections of the new methodology's tree that the
project lacks (by title, top level and one level down) and how many pages each of its levels would count. `PUT
/v1/projects/:id/methodology` creates only the sections the person ticked. No page is deleted, moved or edited, and
unlinking (`null`) returns the project to exactly what it had. Both need a workspace admin or the project's maintainer
(`PermissionService.requireProjectManage`). The settings UI is `ProjectMethodologySection.vue` under **Project
settings → Policies → Methodology**.

**Archiving.** A blueprint a project links cannot be deleted: `DELETE /v1/blueprints/:id` answers 409 with the number
of projects using it. It can only be switched off (`project_blueprints.enabled = false`), which hides it from pickers
while linked projects keep reading it. There is no separate archive column.

**Scaffolding** from a methodology links the new project (the wizard sends `methodologyKey`) instead of copying its
conventions into it. Projects scaffolded before this milestone keep their copied rows and are not migrated.

## Materialization

A methodology's templates, workflows, styleguide, glossary terms and agents become real rows owned by it
(`blueprint_id` set, `project_id` null), one set per workspace. `MethodologyMaterializerService`
(`apps/api/src/blueprints/methodology-materializer.service.ts`) writes them when a version is saved or when a
blueprint is first linked, and updates them in place afterwards:

- Workflows and the styleguide are named `"<name> (<8 hex of the blueprint id>)"` (`ownedName`), so they never clash
  with a workspace row of the same name.
- Agents are keyed `ownedAgentKey(key, blueprintId)`: `modeller` becomes `modeller-be27393b`. A built-in agent key
  stays itself, so a level may name a built-in agent directly. The methodology owns the name, instructions, tools and
  tier. An admin may switch one off or pin a model, and a re-save keeps both; it cannot be edited or deleted. An agent
  the methodology no longer declares is switched off, not deleted.
- Only a methodology, or a blueprint a project already links, is materialized on save, not every blueprint with
  conventions. That keeps a library of plain blueprints from filling the template list.
- Built-in methodology rows refresh only on (re)link or save. A release that changes a built-in reaches linked projects
  at the next link or save (a `ponytail:` marker in `project-methodology.service.ts`).

## Levels

`levelOf(templateRef, levels)` (contracts) is pure: the first level that lists the page's template, else none. It is
never a column. `projectLevels` reads every project's levels in one query, and `pageLevel` turns one into what a
response carries (`{ key, name }` in the reader's language).

- `GET /v1/documents/:id` and every search result carry `level` when the page has one.
- `GET /v1/projects/:id/levels` lists the levels in order with the pages the caller can see at each, and each level's
  declared `agentKey`.
- `SearchDto.level` names a level to lean towards: `levelBoost` in `apps/api/src/search/ranking.ts` multiplies a
  matching page's score by `1 + LEVEL_PRIOR_WEIGHT` (0.25). Nothing is filtered out. Without `level`, the ranking is
  unchanged. The weight is a constant, not a tuned knob.

**Graph layers are a different axis.** The `system → component → interface → code` layers of
[63](63-graph-layers.md) describe the graph's entities and are derived from entity keys. Methodology levels describe
how a team works and are derived from page templates. Neither replaces or renames the other.

## Model tiers

`ai_models.tier` (nullable: `small`, `medium`, `large`, set in **Settings → AI → Models**) and `ai_agents.min_tier`.
An agent with a `minTier` and no pinned model resolves through `AiConfigService.resolveAtLeast`: the purpose's routed
model when it meets the tier, otherwise the cheapest available model that does. When none does, the agent falls back
to the usual resolution and the run records `tierUnmet`. An agent without a tier resolves exactly as before. Prices are
compared as plain numbers whatever their currency (a `ponytail:` marker), which is fine until one tier mixes USD and
RUB models.

## The chat level picker

`LevelPicker.vue` sits beside the agent picker in the chat composer
(`apps/web/src/entities/assistant/components/`). It shows only when the chat is about a page whose project's
methodology declares levels: the composer reads the page's `projectId`, then `GET /v1/projects/:id/levels`.

- `PostAssistantMessageDto.level` takes a key, `null` to clear, or nothing to keep the thread's.
  `assistant_threads.level` remembers it. The message, not a thread PATCH, sets it: a chat on a page has no thread
  until its first message, so the choice is sent with that message either way.
- `AssistantService.turnLevel` runs before the user message is stored. A named level must be declared by the
  methodology of the grounding page's project (`dto.documentId ?? thread.documentId`, read under the caller's scope);
  otherwise the request is a 400 `level-unavailable` and nothing is written. A remembered level that no longer applies
  is dropped silently.
- With a level, the level's agent (through `ownedAgentKey`) is the turn's default when the message names no agent. An
  explicit pick, `auto` included, wins. The same `conversational(agent, mode)` check applies, so in Ask mode an agent
  with write tools falls back to the mode's default.
- The level's guidance follows the agent's instructions in the system prompt, and the turn's `search_knowledge` calls
  pass `level` as the search prior, from the tool context and never from tool arguments. Without a level the prompt is
  byte-identical, which `test/chat-level.spec.ts` pins.

## The built-ins

**Knowledge-Driven Construction** (`construction`, `apps/api/src/blueprints/built-in/construction.ts`) works top-down
from a settled plan:

| Level | Templates | Agent (tier) |
| --- | --- | --- |
| L0 Intent | `intent` | `modeller` (large) |
| L1 Ontology | `entity` | `modeller` |
| L2 Rules | `rule` | `modeller` |
| L3 Behavior | `use-case`, `quality-scenario` | `system-designer` (large) |
| L4 Architecture | `adr`, `component` | `system-designer` |
| L5 Contracts | `api-spec` | `contract-writer` (medium) |
| L6 Units | `work-unit` | `unit-writer` (small) |
| L7 Code | — | — |

Each level's guidance says what the level answers and when it is complete. The tree has a section per level and a
Glossary page. The conventions are a styleguide (one invariant per rule page, glossary terms only, measurable goals, no
solution in an intent, link the level above) and five glossary terms. One workflow, *Draft rules from an entity*, runs
`ai.generate` → `ai.draft` (`builtin:rule`) → `review` from an `erd` page. The agents carry read, draft and ask tools
only: a level agent with a write tool would be skipped in Ask mode, the default, so writing stays with Agent mode's
author. `architect` is a built-in agent key, hence `system-designer`.

**Discovery-first** (`discovery`) keeps its tree and gains four levels, question → options → findings → decision, with
an `investigator` agent (medium; `researcher` is a built-in key). Only `question` has a template
(`research-question`), so research-question pages sit there. The other three levels exist so a chat can work at them.

Four built-in templates were added for KDC, in English and Russian: `intent`, `rule`, `quality-scenario` and
`work-unit`. The scaffold wizard's start cards show a methodology's level count.

## Routes

| Route | Who | Does |
| --- | --- | --- |
| `GET /v1/projects/:id/methodology` | viewer | The linked methodology and its levels; `null` when none |
| `GET /v1/projects/:id/methodology/preview?blueprint&locale` | admin or maintainer | The sections linking would add and each level's page count; writes nothing |
| `PUT /v1/projects/:id/methodology` | admin or maintainer | Link, switch or unlink, and create the confirmed sections |
| `GET /v1/projects/:id/levels` | viewer | Levels in order, the caller's pages at each, each level's agent |
| `POST /v1/assistant/threads/:id/messages` `{ level }` | as before | Work the turn at a level (400 `level-unavailable` when it does not apply) |

## Operations

Four migrations, all additive and nullable, so the previous release runs against the migrated schema and code rolls
back by retag: `20270203100000_methodology_scope`, `20270203110000_methodology_conventions` (also re-creates
`ai_skills_one_styleguide_per_scope` to include `blueprint_id`, accepting exactly the rows the old index did),
`20270203120000_methodology_agents` and `20270204100000_assistant_thread_level`.

## Left out

- **Refinement checks as merge-request gates** (a page with no parent at the level above, an uncovered parent). They
  need a defined "refines" edge first. Today it is a styleguide rule and guidance.
- **Control points per level** beyond publish mode and the `review` workflow step.
- **The execution side**: running code tasks, write-set enforcement, scheduling.
- **Several methodologies per project**, or one per page subtree. One link per project keeps resolution a single
  order.
- **A declared handoff** from Discovery-first to KDC. Switching by hand covers it.
- **Moving older projects onto a methodology automatically.** Their copied rows are theirs.
- **The wizard's Conventions step** still offers ticks that a linked scaffold ignores.
- **Levels in chat-bot replies and MCP tools**, a project selector for chats without a page, and suggesting a level
  from the question.
