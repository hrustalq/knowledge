# 73 — Project scaffolding

Issue [#716](https://github.com/hrustalq/knowledge/issues/716). Before this,
`POST /v1/projects` took a name and a description and seeded nothing. Every
team rebuilt its structure and conventions by hand, page by page. The three
real bases on prod had three distinct shapes nobody could reuse: a
discovery-first research base of numbered chapters, a code product with a
Decisions list of `ADR NNNN:` pages, and a service's documentation whose
«Процесс 1 (например: …)» placeholders showed it had been scaffolded by hand.
A page template described one page. Nothing described a set.

Now a project can start from a **blueprint**: a page tree plus the conventions
the project writes by. `/projects/new` is a wizard that picks one, lets the
person reshape it, and creates the project, every page and the conventions in
one transaction.

| Phase | PR | What landed |
| --- | --- | --- |
| 1 | [#717] | Schema, built-ins, `research-question` template, `POST /v1/projects/scaffold`, scaffold stubs |
| 2 | [#718] | The wizard at `/projects/new` with Blank and the built-ins |
| 3 | [#719] | Collections on any page; numbered **New page** |
| 4a | [#720] | Saved blueprints (`project_blueprints` + versions), derive from a project (API) |
| 4b | [#721] | From a project in the wizard, Save as blueprint, `/settings/blueprints` |
| 5 | [#722] | Describe it: the `scaffolder` agent drafts a blueprint from a brief |
| 6 | [#723] | MCP: `knowledge_list_blueprints`, `knowledge_scaffold_project` |

[#717]: https://github.com/hrustalq/knowledge/pull/717
[#718]: https://github.com/hrustalq/knowledge/pull/718
[#719]: https://github.com/hrustalq/knowledge/pull/719
[#720]: https://github.com/hrustalq/knowledge/pull/720
[#721]: https://github.com/hrustalq/knowledge/pull/721
[#722]: https://github.com/hrustalq/knowledge/pull/722
[#723]: https://github.com/hrustalq/knowledge/pull/723

The vocabulary (blueprint, collection, scaffold stub) is in
[`GLOSSARY.md`](../../GLOSSARY.md#starting-a-project).

## Decisions

Taken with the user before building (2026-11-02):

- **A blueprint is a tree plus conventions.** Conventions are the styleguide,
  project templates and glossary seed terms. Connectors, agents, triggers and
  sites are not part of one.
- **Three sources besides the built-ins:** a saved blueprint, one derived from
  an existing project, and one the `scaffolder` drafts from a description.
  Saved ones follow the template model ([42](42-page-templates.md)): built-ins
  are code, rows override or add, every content change is an immutable version.
- **Pages are published at once**, not private drafts
  ([66](66-drafts-publishing.md)). A skeleton nobody else can see is not a
  structure. What keeps the skeletons out of search is the scaffold stub, not
  visibility.
- **One endpoint, one transaction.** A failure anywhere leaves no project and
  no pages.
- **A collection is two columns on `documents`**, on any page, not a page kind.
- **No feature toggle.** Blank must always work. Describe it, which needs a
  model, hides with `assistant` ([70](70-feature-toggles.md)).
- **New projects only in v1.** The service takes a `parentId` for adding a
  blueprint under an existing page; the wizard does not offer it.
- **MCP gets list and scaffold.** Derive and generate are not tools.

## Blueprints

### The shape

`Blueprint` in `@knowledge/contracts/blueprints`:

- `name`, `description`, `icon` (an emoji).
- `tree`: `BlueprintNode[]`. A node has a `title`, an optional `category`, a
  `templateRef` **or** a markdown heading skeleton in `body`, `guidance` (what
  belongs on the page), a `collection` rule and `children`.
- `conventions`: `styleguide` (`{ description, rules: StyleRule[] }`, the
  [53](53-doc-quality.md) shape), `templates` (template markdown with its
  `template:` frontmatter) and `glossary` (`{ term, definition, aliases }`).

Every text a blueprint carries is a `BlueprintText`, a partial `{ en, ru }`
record. `blueprintText(text, locale)` reads it in the chosen language and falls
back to any language present, so a blueprint written only in Russian still
scaffolds an English project, in Russian. The skeleton language is the last
thing the wizard asks for, which is why built-ins carry both.

### The one parse

`parseBlueprint` (`apps/api/src/blueprints/blueprint.schema.ts`, zod) is the
only door. The wizard's edited tree, a saved row, an inline MCP blueprint, a
derived one and a generated one all pass it before anything is written or
returned. It is API-side because `@knowledge/contracts` carries no runtime
dependency. It refuses unknown fields (`strictObject`), a template ref
`parseTemplateRef` cannot read, a category outside `DOCUMENT_CATEGORIES`, and a
tree over `BLUEPRINT_MAX_PAGES` (200) or deeper than `BLUEPRINT_MAX_DEPTH` (5).
A refusal is a 400 `error.blueprint.invalid` naming the first five problems by
path, with up to 20 zod issues in `details.issues`.

### Built-ins

Code in `apps/api/src/blueprints/built-in/`, keyed by
`BUILT_IN_BLUEPRINT_KEYS` (`discovery`, `code-product`, `service-docs`,
`blank`). Every page has en and ru titles and guidance (`page(en, ru, …)` in
`built-in/page.ts`).

- **Discovery-first** (`discovery`): 00 — Decision summary; 01 — Goals and MVP
  scope, 02 — Architecture, 03 — Risks and threat model and 04 — Economics, each
  a collection of `builtin:research-question` pages; 05 — Pilot (Pilot design,
  Test scenarios, Metrics).
- **Code product** (`code-product`): Product (Vision and audience, Brief, MVP
  scope, Business model, Delivery plan); Domain (Domain model, Glossary);
  Discovery (collection, `{{date}} session`); Architecture (System overview +
  Components, a collection of `builtin:component`); Decisions (collection,
  `builtin:adr`, `ADR {{n:4}}: `); Gotchas (collection).
- **Service documentation** (`service-docs`): Overview (Description,
  Requirements, Links, Roadmap); Information model (`builtin:entity`); API
  (`builtin:api-spec`); Processes; UI/UX (`builtin:use-case`); Integrations;
  Testing (`builtin:test-case`) — each a collection; then Role model, FAQ and
  Deprecated.
- **Blank** (`blank`): no pages, no conventions.

Phase 1 also added the built-in page template `research-question` (en/ru:
Question, Options, Criteria, Findings, Decision, Open questions) beside the
others in `apps/api/src/templates/built-in/`.

### Saved blueprints

`project_blueprints` (one row per saved blueprint or per built-in override,
`built_in_key` set for the latter) and immutable `project_blueprint_versions`
(the `Blueprint` JSON as `parseBlueprint` returned it). `BlueprintsService`
follows the template model:

- A row with `built_in_key` **overrides** a built-in: new content, or
  `enabled = false` to hide it. `current_version = 0` means a row that only
  hides. Deleting an override resets the built-in.
- A row without one is a **saved** blueprint, listed after the built-ins,
  newest first. Its key is its id.
- A content change appends a version; `enabled` does not.
- Nothing pins a blueprint. A scaffold copies it, so a saved one is deleted
  outright, in one guarded statement (a second delete is a 404).

`resolve(workspaceId, key)` is what scaffold calls: a built-in key with its
override applied, or a saved id. A hidden or unknown key is a 404, since a key
the list does not offer is not one.

Writes are **admin**, the bar for a workspace-wide template: a blueprint
changes what every editor in the workspace is offered. Both models are filed in
`workspace-teardown.inventory.ts` (`ProjectBlueprint: 'workspace'`,
`ProjectBlueprintVersion: 'parent'`).

## The wizard

`/projects/new` (`ScaffoldWizardPage.vue`, `meta: { fill: true, bare: true }`)
replaces the create-project dialog. The workspace switcher's dialog now makes
workspaces only, and a new workspace's first-project step can hand off here.

It is one xstate machine (`modules/projects/model/scaffold-machine.ts`, the
workflow wizard's pattern). Its snapshot is stored, so a reload keeps the
edits, and the page clears it on route leave so the next visit starts at Start.
The machine holds the edited blueprint and where it came from (`origin`:
a listed blueprint, a project it was derived from, or a description). Nothing
is written until Create.

**Start → Shape → Conventions → Create.**

Each step is a history entry (`?step=start|from-project|describe|shape|conventions|create`),
so the browser's Back and Forward walk the wizard. A move the wizard makes
pushes an entry. An entry the browser lands on is sent to the machine as
`GOTO`, which refuses a step the context cannot stand on (Shape before a pick,
or after Start over), and the page then rewrites the URL to where it is. The
footer's Back is the browser's Back whenever a wizard entry sits behind it.
Every entry carries the wizard's first position in `history.state`, across a
reload too, so Cancel unwinds them all in one `router.go`.

From 64rem up, Start, Shape and Create share one spine: a 24rem rail on the
left, the thing it describes filling the rest, at the header's gutters.

- **Start** offers the blueprints with pages (built-ins, then saved), then
  Blank, From a project and Describe it. On a wide screen a click previews the
  blueprint beside the list (`BlueprintSectionMap.vue`: top-level sections as
  columns with their guidance and pages), and **Use this blueprint** or a
  double-click takes it. Narrower, there is no preview and a tap takes it at
  once. Blank has nothing to shape and goes straight to Create; Back from there
  returns to Start.
- **Shape** edits the tree (`BlueprintOutline.vue`, `BlueprintNodeEditor.vue`):
  rename, add, delete, drag to reorder, mark a node as a collection with a child
  template and title pattern, and type its initial items. The pane previews the
  selected page's skeleton. A strip says where the outline came from and
  whether a model drafted any of it. **Save as blueprint**
  (`SaveBlueprintDialog.vue`, admins) updates the listed blueprint it started
  from, saves a new one, or replaces a built-in with an override. The wizard is
  the only blueprint editor.
- **Conventions** (`BlueprintConventions.vue`): styleguide rules, the template
  list and the glossary checklist, in two columns on an xl screen. Terms offered by derive start unticked.
- **Create**: name, description, avatar emoji, restricted, and the skeleton
  language (en/ru, default the UI locale), beside a rail with what it will make
  and the full outline. It calls
  `POST /v1/projects/scaffold` with the edited blueprint inline.

The two Start panels that fetch, **From a project**
(`ProjectBlueprintPicker.vue`) and **Describe it**
(`BlueprintDescribePanel.vue`), are full-bleed split panes like Shape. From a
project previews the derived outline before **Use this outline**.

`/settings/blueprints` (`BlueprintsSettingsPage.vue`, a nav row after
Templates) lists every blueprint, hidden built-ins and switched-off saved ones
included, since that is where they come back. Its pane shows a blueprint's tree
and conventions, and is where an admin hides, resets, switches off or deletes
one. Content changes go through **Open in wizard** → Save as blueprint. The
project page has **Save structure as blueprint** (admins, a project with
pages), which derives from that project and saves the result.

## From a project

`POST /v1/blueprints/derive` `{ workspaceId, projectId }`
(`BlueprintDeriveService`, editor on the target workspace, writes nothing).

**Who may read what.** The source project may sit in any workspace the caller
belongs to. It is read under the caller's `AccessScope` **in the source's
workspace**: `requireResource` on the project first (a refusal carries no
title, 403 for a member and 404 otherwise), then `getTree` under that scope. A
restricted page the caller cannot open contributes nothing, not even its title.
Private draft pages are skipped. The picker asks each workspace's project
roster, so it lists only projects the caller can see. With nothing to pick, it
shows a read-only gallery of the built-ins' sample trees.

**Rules first** (`derive-rules.ts`, pure, pinned by a spec). Only titles and
headings travel, never page text:

- The tree to depth 3, at most `BLUEPRINT_MAX_PAGES` nodes.
- `headingsOf` reads a page's h2–h4 lines outside code fences. A page with a
  built-in template keeps the template ref; otherwise its headings become the
  node's `body`. Past 300 object-storage reads only titles travel (`ponytail:`
  marker).
- A catalogue category carries over; `other` and free text do not.
- Each title is keyed by its script (`titleLocale`: Cyrillic is `ru`).
- **Leaves fold into a collection** rather than being copied. Numbered leaves
  come first: at least two, and at least half of the leaf siblings, sharing a
  prefix such as `NN —`, `ADR NNNN:` or an ISO date. The prefix becomes the
  pattern (`ADR {{n:4}}: `, `{{date}} `), padded to the width of a
  zero-led digit run. Otherwise three or more leaves sharing one heading
  skeleton fold. A built-in template the folded pages share becomes the child
  template.

**Conventions.** The source project's own templates travel as version-1
project templates, plus its workspace's templates when that is another
workspace (in the same one they are offered already). Built-in overrides and
archived templates stay behind. Glossary terms come back in `glossary`, apart
from the blueprint, and **only when the source is in the same workspace**; the
wizard offers them unticked.

**Then one model call.** When the target workspace runs `assistant` and the
`scaffolder` is enabled, one JSON call (`AiUsageOperation` `blueprint-derive`,
billed to the target workspace) reads the outline wrapped untrusted and drafts
a styleguide (at most 10 rules) and per-node guidance. Only node ids the call
handed out and known severities count. With `assistant` off, the agent off, the
budget spent or the call failed, the rules' result stands and `drafted` is
`false`.

## Describe it

`POST /v1/blueprints/generate` `{ workspaceId, brief, blueprint? }`
(`BlueprintGenerateService`, editor, `@Feature('assistant')`, writes nothing).
The brief is 10–4000 characters; `blueprint` is an optional starting outline to
adapt. The Start card is hidden when `assistant` is off, and the route 404s.

The `scaffolder` built-in agent (`apps/api/src/agents/built-in-agents.ts`)
requires `json` and `tools`. Its shared instructions are joined by a per-call
contract (`DERIVE_CONTRACT`, `GENERATE_CONTRACT`).

- **Tools** are the agent's own list intersected with `list_document_tree` and
  `search_knowledge`, run through `AssistantReadToolsService.execute` under the
  caller's principal and workspace. A name outside the set is refused on
  execution, whatever the model asks. A model without `tools` gets one JSON
  call instead.
- **Templates** offered are the workspace-wide and enabled built-in ones, by
  ref. The brief is wrapped untrusted (origin `brief`), as is a starting
  outline.
- **Language.** The brief's script decides it, and it is stated in the system
  message as well as the user turn. A mention in the user turn alone lost to an
  English contract: gpt-6-luna wrote English titles for a Russian brief.
- **The answer** goes through `drafted-blueprint.ts`, the one reader of
  scaffolder output (derive uses it too). `readDraftedTree` clips strings to the
  schema's limits and drops unknown template refs and categories, titles with
  `{{…}}` in them and anything past the page and depth limits. `keyed(text)`
  keys text by its script, not by the language asked for, so a miss cannot land
  under the wrong locale. Then `parseBlueprint`. Nothing usable is a 422
  `error.blueprint.generateEmpty`. Usage is `blueprint-generate`.

## Create

`POST /v1/projects/scaffold` (`ProjectsController.scaffold`, editor,
`@Returns('ScaffoldProjectResponse')`):

```
{ workspaceId, name, description?, locale,
  blueprintKey? | blueprint?,     // exactly one, else 400 error.blueprint.oneSource
  parentId?, restricted?, avatarEmoji?, avatarColor? }
```

**A styleguide needs a workspace admin.** Styleguides are trusted prompt text,
admin-only at `PUT /v1/ai/styleguides`, so a blueprint carrying one is checked
for `admin` before the scaffold runs. Templates and glossary terms are
editor-level, as their own routes are. A `parentId` scaffold writes no
conventions, so it needs no admin.

`ProjectScaffoldService.scaffold` runs in **one PG transaction** (60 s timeout)
inside `withLocale(locale)`, so built-in templates render their skeletons in
the chosen language:

1. **The project row**, through `ProjectsService.create`. With `parentId`, the
   parent page's project instead, after `requireCreateUnder` on that page.
2. **Its face**, before any page: the emoji, and `restricted` with a `manage`
   grant for the creator. A page is born under its project's restriction
   (`recomputeRestrictedBy` in `createDocument`), so a restricted scaffold is
   never readable workspace-wide, not even for a moment. Live gateways drop
   cached scopes on commit.
3. **Conventions** (new projects only): the styleguide as the project's own
   (named after the project, suffixed with the project id when the name is
   taken, since styleguide names are unique per workspace), each template as a
   version-1 project template, glossary terms deduped by spelling.
4. **The tree**, depth first, so a parent always exists. Each page goes through
   `DocumentsService.createDocument`, which joins the transaction: its source
   reaches object storage before the commit, and its ingestion job row is the
   outbox, enqueued once the commit lands. A template node starts as the
   template's skeleton with its declared placeholders left as `{{name}}`; any
   other node is `# title`, its guidance as a `[!NOTE]` panel, then its heading
   skeleton. Under a collection, an initial item's title comes from the rule
   (`nextChildTitle`) and its template defaults to the child template. Each
   first revision is stamped `origin = 'scaffold'`, and a collection node's rule
   lands on its page.

Pages are `visibility: 'workspace'` (or under the project's restriction). The
response is the project summary and `pageCount`. A failure anywhere rolls back
every row. Source objects already written to storage stay behind, but no row
points at them.

## Scaffold stubs

A **scaffold stub** is a page whose default-branch head is still the revision
the scaffold wrote. `document_revisions.origin` (nullable, migration
`20261230100000_scaffold_origin`) is written only by the scaffold writer, and
`'scaffold'` (`SCAFFOLD_ORIGIN`) is its only value.

`common/scaffold-stub.ts` has the two spellings, pinned against each other in
`test/scaffold.spec.ts` and, against a real database, in
`test/scaffold-stub.e2e-spec.ts`:

- `isScaffoldStub(head)` over a head already in hand;
- `scaffoldStubSql(alias)` over `documents <alias>`.

Where they apply:

| Surface | How |
| --- | --- |
| Ingestion | `IngestionProcessor` completes a stub's job without chunking or embedding, and records the signature so the drift sweeper does not re-queue it |
| Search and Ask | `SearchService` drops a page whose head is a stub; Ask and `knowledge_search` read through it |
| llms.txt / llms-full.txt | `AiReadableService` skips stub heads ([37](37-ai-readable-output.md)) |
| Knowledge health | The health CTE excludes stubs: nothing to verify, own or count ([40](40-knowledge-health.md)) |
| Usage analytics | The dead-page list skips them: quiet by design, not dead ([58](58-usage-analytics.md)) |

A stub stays in the tree and the page lists, which is where people find it to
fill in. The first real revision ends it with no code of its own: the head moves
to a revision with no origin, which takes the whole pipeline. Filling stays per
page through the existing **Fill with AI** path.

## Collections

A **collection** is a page whose future children follow a rule:
`documents.child_template_ref` and `documents.child_title_pattern` (nullable,
in the same `20261230100000_scaffold_origin` migration as `origin`, no
backfill). Any page can be one.

- **The pattern** is a title prefix. `{{n:W}}` is the next number, zero-padded
  to W digits; `{{date}}` is today, ISO, so titles sort.
  `nextChildTitle(pattern, siblings, title?)` (`@knowledge/contracts`) takes the
  highest number already in that position among the siblings and adds one.
  Gaps are kept, never refilled, and archived children count, so a number an
  archived page holds is not handed out again.
- **The rule** is edited in the editor's settings sheet
  (`CollectionRuleFields.vue`) and saves on its own (PATCH), not at Publish.
- **New page** under a collection reads `?parent=` in `EditorPage`'s opening
  step and calls `nextInCollection` (`modules/editor/model/collection.ts`): the
  next title (`ADR 0020: `) and the child template. A template picked in the
  gallery wins over the child template.
- A built-in template that requires a placeholder (the ADR's `number`) renders
  with `skeleton: true` here and in scaffold, so placeholders stay `{{name}}`.

## MCP

Two tools (`apps/api/src/mcp/mcp.service.ts`):

- **`knowledge_list_blueprints`** (viewer) returns what
  `BlueprintsService.list` returns.
- **`knowledge_scaffold_project`** (in `WRITE_TOOLS`, so hidden from read-only
  keys) takes `blueprintKey` **or** inline `blueprint`, plus `workspaceId`,
  `name`, `description`, `locale`, `parentId` and `restricted`. It guards editor
  first, then admin when the blueprint has a styleguide and no `parentId`, and
  runs `ProjectScaffoldService.resolve` + `scaffold`, the controller's own
  calls. Over MCP and over REST, `discovery` gave identical trees (checked
  live, 9 pages, all `scaffold` origins). `avatarEmoji` / `avatarColor` are not
  wired.

The generated SKILL.md ([33](33-connect-ai.md)) has a playbook, *Start a project
from a blueprint*, in the write flows only. Derive and generate are not tools.

## Routes

| Route | Who | Does |
| --- | --- | --- |
| `GET /v1/blueprints?workspaceId&includeDisabled` | viewer | Built-ins with overrides applied, then saved ones |
| `POST /v1/blueprints/derive` `{ workspaceId, projectId }` | editor on the target, sight of the source | A blueprint read off a project; `glossary`, `drafted` |
| `POST /v1/blueprints/generate` `{ workspaceId, brief, blueprint? }` | editor, `assistant` on | A blueprint the scaffolder drafted |
| `POST /v1/blueprints` | admin | Save a blueprint, or override or hide a built-in (`builtInKey`) |
| `PATCH /v1/blueprints/:id` | admin | Change content (appends a version) or `enabled` |
| `DELETE /v1/blueprints/:id` | admin | Delete a saved blueprint, or reset a built-in |
| `POST /v1/projects/scaffold` | editor; admin with a styleguide | Create the project, conventions and pages in one transaction |

## Limits

- **New projects only.** `parentId` is in the service and the MCP tool, not in
  the wizard.
- **No page bodies are drafted at scaffold time.** A page is filled one at a
  time through Fill with AI.
- **Derive past 300 pages copies titles only**, and a folded skeleton with no
  built-in template is dropped rather than carried as a project template
  (`ponytail:` markers in `blueprint-derive.service.ts` and `derive-rules.ts`).
- **From a project asks one roster per workspace.** Someone in dozens of
  workspaces would want one cross-workspace route (`ponytail:` marker in
  `ProjectBlueprintPicker.vue`).
- **A scaffold is a copy.** A later change to a blueprint does not reach the
  projects made from it.
- **Not exercised live:** the glossary offer from derive, and a derive with
  `drafted: true` (the local provider returned 402 in phase 4a).
