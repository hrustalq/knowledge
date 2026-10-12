# 42 — Page templates

Issue [#69](https://github.com/hrustalq/knowledge/issues/69), shipped in
#146–#150. A template is the shape a page starts from: an ADR, an RFC, a
runbook. A page can start from one in the tree, through `/template` in the
editor, with the assistant filling it in, through MCP, from a workflow step,
or at import.

Before this every page started blank or from an import. Pages of the same
kind came out shaped differently, which made them harder to review, to ground
an answer in, and for a workflow to produce consistently. A template here also
carries graph metadata (category, tags, typed relations), so a page made from
one is linked into the graph from its first revision. That part is ours; the
gallery itself is table stakes (Confluence, Notion, Yandex Wiki).

## Templates are not documents

Templates live in their own tables (`page_templates`,
`page_template_versions`), not as `documents` rows:

1. **A document is indexed.** A template stored as a page would show up in
   search, the graph, `list_document_tree` and assistant retrieval, and its
   `{{placeholders}}` and example relations would become entities about
   nothing.
2. **Branches and merge requests are too heavy** for a skeleton a few editors
   maintain. The cost is that a template edit is not reviewed; workspace-wide
   templates need `admin` instead.
3. **Versions still matter.** Each source change writes an immutable
   `page_template_versions` row and bumps `current_version`. A rename or icon
   change does not. "Which shape produced this page" therefore has a stable
   answer: `documents.template_ref` + `template_version`. Neither has an FK,
   so archiving a template never touches its pages.

A template is closer to a `WorkflowDefinition` (data plus a version) than to a
page.

## Built-ins are code

Seven built-ins ship in English and Russian: `adr`, `rfc`, `runbook`,
`postmortem`, `api-spec`, `use-case`, `entity`
(`apps/api/src/templates/built-in/`). Each is a TS module with a `version`
constant, so nothing is copied into `dist`. **They are never seeded as rows**
(the `built-in-agents.ts` argument): a release can improve the ADR template
for every workspace that never touched it, and an empty table reproduces the
built-in gallery exactly.

A row with `built_in_key` set is a workspace's override:

- **Customise.** The row holds versions of its own. They **continue from the
  shipped version** (an override of ADR v1 starts at v2), so `builtin:adr`
  keeps resolving and versions stay comparable. The ref never changes, which
  is why a workflow or a page naming `builtin:adr` picks up the override.
- **Hide.** `enabled = false`. The template leaves the gallery and still
  resolves for the pages made from it.
- **Reset.** `DELETE /v1/templates/:id` deletes the override row (admin).
  Custom templates are never deleted (`notDeletable`); they are archived,
  which hides them from the gallery but keeps them resolvable.

The built-ins' language is picked by the caller's locale at render time. Once
rendered, the text is page content and is never translated again (feature
18).

## Format

A template is markdown. `tags:` and `relations:` in its frontmatter pass to
the page unchanged; the reserved `template:` key is stripped:

```yaml
---
tags: [adr]
relations:
  - type: DESCRIBES
    target: "{{component}}"
template:
  category: architecture
  titlePattern: "ADR-{{number}}: {{title}}"
  placeholders:
    - { name: number, kind: text, required: true }
    - { name: component, label: Affected component, kind: entity, hint: "service:billing" }
  aiInstructions: Fill Context/Decision/Consequences; list alternatives considered.
---
# {{title}}
```

- **System placeholders** are always filled: `title`, `date` (in the
  caller's locale, pinned to UTC so a server render and a browser preview
  give the same day), `author`, `project`, `parent`.
- **Declared placeholders** have a kind:
  - `text`, `date`: substituted as text.
  - `user`, `page`: an id, rendered by code into the editor's mention
    encoding. Its label is resolved **inside the workspace**, so a foreign or
    invented id renders as nothing.
  - `entity`: folded through `normalizeEntityKey` wherever it is a relation
    target.
- **Only declared names are substituted.** An undeclared `{{baseUrl}}` stays
  literal, which is what lets the API-spec template show Handlebars examples,
  and `\{{x}}` writes a literal `{{x}}`.
- **A default relation or tag whose placeholder was left blank is dropped**,
  never written as `service:`.
- **A relation the graph would refuse is refused on save** (`invalidRelation`
  through `normalizeRelationType` + `isAuthorableRelationType`), not months
  later when a page is created from the template.

Rendering is pure and lives in `@knowledge/contracts/templates`
(`renderTemplate`, `renderTemplateTitle`, `renderTemplateFrontmatter`,
`missingRequiredPlaceholders`). The API, the worker and the gallery's live
preview all call the same functions, so the preview and the created page
cannot disagree. `composeTemplateSource` is the parser's inverse; it lets the
settings editor write a template from a form instead of a YAML box, and
re-emits frontmatter keys it does not model rather than dropping them.

## Shape

```
packages/contracts/src/templates      pure: refs, render, compose, detect placeholders
apps/api/src/templates
  TemplatesCoreModule  (auth-free)    TemplatesService: list/merge, resolve, render, defaults, versions
    ← DocumentsCore, McpCore, AssistantReadTools, WorkflowWorker, Workflows, Import
  TemplatesModule      (API only)     TemplatesController
```

- **`resolve(workspaceId, ref, version?)` never refuses an archived or hidden
  template.** A page or workflow pinned to one must still be able to say what
  it came from. Refusing *new* pages from an archived template is the job of
  `render`, and of `defaults({ live: true })` for import (409 `archived`).
- **Every lookup filters by workspace.** A template uuid from another tenant
  is a 404 in the service, even for a caller that skipped the guard.
- **`defaults()`** serves writers that have no placeholder values: a
  workflow's model, or an import. System placeholders are filled, declared
  ones stay `{{name}}` in the skeleton, and only the unconditional defaults
  survive.

## Routes

| Route | Access | Notes |
| --- | --- | --- |
| `GET /v1/templates?workspaceId&projectId&includeArchived` | viewer, query | Rows (project first, then workspace-wide), then built-ins with overrides applied |
| `GET /v1/templates/built-in/:key` | viewer, query | Declared before `:id` |
| `POST /v1/templates/render` | viewer, body + `@ReadKeyOk` | No write. 400 `placeholderMissing` with `details.missing` |
| `GET /v1/templates/:id`, `:id/versions`, `:id/versions/:version` | viewer, template | |
| `POST /v1/templates` | editor, body | Workspace-wide (`projectId: null`) or a built-in override also needs `admin` (explicit `requireRole`) |
| `PATCH /v1/templates/:id` | editor, template | A source change versions; metadata does not. Same admin rule |
| `POST /v1/templates/:id/archive`, `/unarchive` | editor, template | Built-ins are hidden, not archived |
| `DELETE /v1/templates/:id` | admin, template | Override rows only: reset to default |

`'template'` is a `WorkspaceSource`: `:id` is resolved to its workspace in PG
before the handler runs, so a cross-tenant id is a 403. Name uniqueness per
`(workspace, project)` is enforced app-side, because Postgres treats NULL
`project_id` values as distinct. Errors are `error.template.*` in
`i18n/{en,ru}/error.json`. Limits are constants in `templates.constants.ts`:
200,000 source chars, 30 placeholders, 500 rows per workspace, 2,000 chars per
value. Writes record `template.created|updated|archived|unarchived|reset`
activity (kind `curate`).

## Where a page starts from one

**`POST /v1/documents` with `template: { ref, version?, values?, provenanceOnly? }`**

- Without `content`, the server renders the template (MCP and API-first
  callers).
- With `content`, the caller's content wins, and the template is resolved
  only to record provenance.
- `provenanceOnly` is the editor's path. The editor creates the page and then
  uploads the body by presigned PUT, so a server render would finalize a
  skeleton the author never published.
- In every case the template's category is only a default.

**The gallery** (`TemplateGalleryDialog.vue`, mounted once in AppShell) opens
from the tree's `+` chevron, a row's "New child page from template…", and the
empty tree. It groups templates as project, workspace and built-in, builds a
placeholder form from the meta, and previews the render. "Create" navigates to
`/create?template=&parent=&project=`, which is an opening instruction like
`?tab=` and is dropped once read. The editor keeps `templateRef`/`Version`
in its working copy, so a reload keeps provenance, and the document header
shows a "From template" chip.

**`/template`** (and `/шаблон`) in the editor opens the gallery in insert
mode. It inserts the body at the cursor and merges tags and relations through
`mergeTemplateDefaults`. It is opt-in per editor through a `templateContext`
prop, so comment editors don't offer it.

**Fill with AI.** The gallery's "Describe the page for AI" hands a one-shot
`fill` to the editor (`takeFill`, beside `takeRendered`; a reload never
re-sends it). The editor opens the assistant panel and sends the description
as the first turn. The turn carries `draft.template` **only while the page is
new and unpublished**, and `assistant/template-clause.ts` then appends a
code-owned rule:

- keep the headings;
- make one `edit_draft` replace per section;
- write `TODO:` where the material runs out.

`edit_draft` is offered in Ask mode too, so no mode switch is needed. A ref
that no longer resolves drops the clause instead of failing the turn.

**Workflows.** `WorkflowStepProduces.templateRef` on an `ai.draft` step.
`runDraft` resolves `defaults()` at the template's current version and puts
the skeleton in the user turn. It merges the template's tags, relations and
other frontmatter into the draft, and records
`WorkflowNodeDraft.templateRef`/`templateVersion`.

- The materializer passes that on as provenance. If the version no longer
  resolves (an override reset since drafting), the page is created **without**
  provenance and a warning is logged, rather than stranding a node a person
  approved in `materializing`.
- A reviewer's draft edit keeps the stored provenance (`whitelist: true`
  would strip it from the DTO).
- An unknown, archived or hidden ref is refused at save as `unknownTemplate`
  (`workflows/workflow-templates.ts`). The same check runs in `validate` and
  in the architect's proposals. `validateGraph` stays pure because the
  browser shares it, and has no database to ask.
- A definition saved before its template was archived keeps running.

**Import.** `SubmitImportDto.templateRef` merges the template's category (as
the default filing), tags, relations and other keys into the reviewed
markdown (`templates/apply-defaults.ts`: unions, never overwriting a key the
page has). **The body is not restructured**: an imported document says what it
says. "Save as template instead" turns the reviewed text into a template and
drops the import. Staged images live under the import, so they are stripped,
and the author is told.

**MCP.**

- `knowledge_list_templates` and `knowledge_get_template` are read tools,
  available to read-only keys.
- `knowledge_create_document` takes `templateRef` + `values` in place of
  `content`. It is already in `WRITE_TOOLS`, so the list is unchanged.
- The generated SKILL.md mentions all three.

**Assistant tools.**

- `list_templates` / `get_template` are read tools, parallel-safe, and in
  every built-in agent's `READ_TOOLS`. A custom agent must opt in, because the
  allowlist intersects.
- `create_document` takes `templateRef` + `values`.

## Trust boundary

Everything about a template is typed by workspace members who may edit
templates, which is not the same as being allowed to instruct a model. The
name, description, `aiInstructions`, placeholder labels, the skeleton, and
whatever `list_templates`/`get_template` return all go to a model inside
`wrapUntrusted(…, 'template')`. Each place that uses a template pairs it with a
code-owned rule outside the wrapper: the assistant's template clause, and
`TEMPLATE_RULE` in `workflow.executors.ts`. The cost is that a template's notes
steer less firmly than system text would; that trade is deliberate.

Graph writes from a template pass the same guards as a hand-written page:
`normalizeRelationType`, `isAuthorableRelationType`, `RELATION_EDGE_TYPES`,
and folding at the top of the write. A template cannot widen the edge
vocabulary.

## Web

| Where | What |
| --- | --- |
| `stores/templates.ts` | Project-scoped roster (archived and hidden included, so a chip can still name them); `offered` for pickers; gallery open state; one-shot `rendered` and `fill`. `rescope()` is called from `projects.switchProject()`. Call `ensureLoaded()` on mount, never in setup: a pending Promise hydrates as `{}` and the store would never load |
| `/settings/templates/:ref?` | `TemplatesSettingsPage.vue`: list by scope, `TemplateEditor.vue` (form + rich editor, no YAML), `TemplateHistory.vue` (diff between any two versions), customise / hide / reset built-ins, archive custom ones. Write controls follow `canWriteTemplate`, the API's role rule |
| `SaveAsTemplateDialog.vue` | Document view and editor ⋯ menus, and import's "Save as template instead". Placeholders are detected from `{{…}}` (`detectPlaceholders`); `unescapePlaceholders` undoes turndown's `{{due\_date}}` |
| `WorkflowStepForm.vue` | "Written into template" on `ai.draft` steps; picking one sets the category. The starter patterns use `builtin:use-case` and `builtin:api-spec` |
| `ImportReview.vue` | A Template field in the review rail |

## Not here

- Database templates and template buttons embedded in pages.
- Re-applying a new template version to pages already made from it. The
  provenance columns make a "drift from template" report possible; it is not
  built.
- A marketplace, or templates shared across workspaces.
- Per-group visibility. Templates follow the workspace ACL.
- Bilingual custom templates (one entry, `locale` per version). Custom
  templates are single-language; the built-ins are not.
- New `DOCUMENT_CATEGORIES` for ADR/RFC/runbook/postmortem. They map to
  `architecture`, `architecture`, `guide` and `process`, and the tag carries
  the kind.
- Template defaults for a page's owner and review interval (feature 39).
- An `app.e2e-spec.ts` flow (create from `builtin:adr` → `indexed` → the
  tag and relation edges exist). Creation, provenance and stored frontmatter
  are covered by specs and hand smokes; the graph edges after indexing are
  not.
