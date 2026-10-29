# 11 — The web app's layers, modules and entities

## What this is

`apps/web/src` is organized by **layer**. Inside the `modules` layer it is
organized by **feature** (a module owns routes), and inside the `entities`
layer by **domain** (an entity owns the blocks, state and composables several
features share). dependency-cruiser enforces which folder may import which
(#566).

This replaces the by-file-type layout (`components/`, `pages/`, `lib/`,
`stores/`, `api/`, `router/`), where one feature lived in four trees and
nothing stopped features reaching into each other: `components/knowledge`
imported from nine sibling feature folders, and folder-level cycles such as
`knowledge` ↔ `merge-requests` and `assistant` → `merge-requests` → `ai` →
`assistant` went unnoticed because the old rules only knew about file-level
cycles.

> **Status.** Phases 0 (the rules) and 1 (the move) have landed, and `help`,
> `captures`, `notifications`, `publishing` and `reader` have their
> `routes.ts`. Midway the design tightened: **modules never import each
> other**, and what they share moves down into a new `entities/` layer. The
> rules below are the tightened ones (and widgets moved above the modules); the 240 violations of them in the tree
> are in the baseline (152 of them a module importing another module). Each
> later phase extracts one entity, leaves first, and shrinks the baseline.
> Sections marked _(planned)_ describe the end state, not the tree today.

## The layers

Left may import right, never the reverse — except that a widget never imports
a module either.

```
app → widgets → modules → entities → stores → shared → core        assets/ from anywhere
```

| Layer       | Holds                                                                                                                                                             | May import                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `app/`      | `App.vue`, the shell (sidebar, topbar, breadcrumbs, switchers, the settings shell), app-wide composables and providers, `app/router/`                             | everything below; a widget by its `index.ts`, a module by its `index.ts` or `routes.ts` |
| `widgets/`  | composite blocks `app/` mounts, one folder each: its own implementation, entities and `shared/`; module content arrives through slots and props                  | entities (by index), stores, shared, core — **never a module**     |
| `modules/`  | one folder per feature, each owning routes (the map below)                                                                                                        | entities (by index), stores, shared, core — **never another module**, never a widget |
| `entities/` | one folder per domain: the components, stores and composables two or more modules share (the entity test below)                                                  | another entity by its `index.ts`, no cycles; stores, shared, core  |
| `stores/`   | cross-cutting Pinia stores only (the list below)                                                                                                                  | shared, core                                                       |
| `shared/`   | business-agnostic: `api/` (generated client, `schema.d.ts`, query helpers), `composables/`, `constants/`, `types/`, `utils/`, `ui/` (the shadcn-vue kit), `layout/` (the page chrome), `i18n/` | core                                                               |
| `core/`     | pure TypeScript: no Vue, no Pinia, no DOM, nothing from `src/` outside `core/`                                                                                    | `@knowledge/*` packages only                                       |
| `assets/`   | static assets and global styles (`style.css`, `styles/`)                                                                                                          | —                                                                  |

The entry files stay at the `src/` root, above `app/`: `main.ts`,
`entry-client.ts`, `entry-server.ts`, `public-main.ts`, `entry-public.ts`,
`entry-public-client.ts`, `export-render.ts`, `sw.ts`. `index.html`,
`reader.html`, `server.js` and `vite.config.ts` load them by path. They reach a
module the way `app/` does.

`core/` is for logic that has no reason to know about Vue or the browser:
parsers, diffing, matchers, state machines' pure halves. Logic the API needs as
well does not go here; it goes to `@knowledge/contracts`, which both apps
already import.

## A module

```
modules/<name>/
  components/   the module's components
  constants/    its constants
  model/        its composables, Pinia stores, services and api.ts
  pages/        its routed pages
  routes.ts     its routes, each page a lazy import() — read by app/router
  index.ts      what the shell mounts from it, if anything
```

- **Only `app/` and the entry files import a module.** The router reads its
  `routes.ts`; the shell reads its `index.ts` (the topbar's `NotificationBell`,
  the sidebar's project avatar). A module nothing in `app/` mounts has no
  `index.ts`. When two modules need the same thing, it is not exported from one
  of them: it moves down into an entity or a widget.
- **When one module must affect another,** it does not call it. It raises an
  event (`stores/events`' `lastEvent`, watched by the module that reacts),
  registers a callback with a cross-cutting store (`registerProjectScoped`,
  `onKnowledgeEvent`, below), or leaves the wiring to `app/` — the router nests one module's route
  inside another's record (`/settings/projects/:id/site` is `publishing`'s page
  under `projects`' record) _(planned for projects)_.
- **`routes.ts`** exports the module's `routes` (top-level records) and, if it
  has pages under the settings shell, `settingsRoutes` (children of
  `/settings`); `app/router` spreads them where the records stood. The router
  imports `routes.ts` directly rather than through `index.ts`: it imports every
  module, and an index would make the entry chunk depend on whatever it
  re-exports (below). `app-via-module-index` allows exactly these two files.
- **`model/api.ts`** holds the module's query keys, `apiQueryOptions` and
  mutation wrappers over the generated client. No hand-written HTTP: the
  `fetch(` ban and its allowlist in `apps/web/eslint.config.js` still apply.
- A feature store is `model/<name>.store.ts` (`templates.store.ts`), so it
  never collides with the plain helper of the same name (`templates.ts`).
- Folders a module does not need are not created. `help` carries one more,
  `help/docs/`: the articles, globbed by `registry.ts`, and the generated
  reference.

## An entity

```
entities/<domain>/
  components/   blocks other layers render
  model/        stores, composables, pure helpers of that domain
  index.ts      its public surface
```

- **The entity test.** A block, store or composable belongs in an entity when
  two or more modules use it, it owns no route, and it has a domain — it would
  have to change when that domain's rules change: `RichEditor`, the document
  tree row, the verification badge, the members composable, the templates
  store. With no domain it goes to `shared/` (the page chrome is
  `shared/layout/`). With one user it stays in that module.
- **`index.ts` is the only door**, for modules, `app/` and other entities
  alike. Explicit named re-exports; everything not exported is private.
- An entity may import another entity through its index (a document's owner
  is a person), never a module or `app/`, and entities may not form a cycle.
  Two entities that need each other are one entity, or share a piece that
  belongs further down.

## A widget

A widget is a composite block that `app/` mounts — above the modules, never
importing one. It is built from its own implementation, entities and
`shared/`; whatever a module contributes reaches it through slots and props
from `app/`. One folder per widget with an `index.ts`, imported only through it
(`widget-via-index-only`). `widgets/` is empty today: the page chrome that sat
there in phase 1 is domain-less and every module renders it, so it moved down
to `shared/layout/`, and the person chip and hover card have a domain, so they
are `entities/person`. A shell block becomes a widget when it is composed from
more than one place in `app/`.

`shared/layout/` may not import a store either. The one piece of app state the
chrome needs — which `PageRail` widgets are open, remembered per surface — is a
`RailMemory` interface declared in `shared/layout/page-chrome.ts`; `App.vue`
provides `stores/layout` under `RAIL_MEMORY`, and `PageRail` injects it.

## Indexes are side-effect free, and the build is told so

An `index.ts` (module, entity or widget) holds only named re-exports from its own
files: an ESLint rule on `src/{modules,entities,widgets}/*/index.ts` refuses anything
else, `export *` and a declaration of its own included. A Vite plugin in
`vite.config.ts` marks those files `moduleSideEffects: false`, which lets the
bundler bind an importer straight to the files it uses.

Without the plugin, an index costs every importer everything it re-exports:
the bundler assigns chunks by reachability, and a component with a `<style>`
block or a CSS import cannot be tree-shaken out of a re-export. Measured on
this tree: one unused re-export of the workflow graph editor grew the entry
chunk from 765K to 930K JS, and routing three pages through one index grew
their chunks by 7–21K. With the plugin both cost 0. The declaration ban is
what keeps it that way: an index that declares something is included whole by
whoever uses that declaration, eager re-exports and all (a lazily loaded dialog
declared in an index put 57K back into the entry chunk).

A component that loads on demand is declared as
`defineAsyncComponent(() => import('./X.vue'))` in its folder's
`components/lazy.ts`, and the index re-exports that.

## The import rules

| Rule (`.dependency-cruiser.cjs`)                                                                                                         | Fails on                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `modules-import-no-app`, `entities-import-no-module`, `widgets-import-no-module`, `stores-import-only-shared`, `shared-is-business-agnostic` | any import pointing left in the layer line, and a widget importing a module                            |
| `no-module-to-module`                                                                                                                    | `modules/a/**` importing anything in `modules/b/**`, index included                                    |
| `app-via-module-index`                                                                                                                   | `app/` or an entry file importing a module file other than its `index.ts` or `routes.ts`               |
| `entity-via-index-only`, `entity-via-index-only-outside`, `widget-via-index-only`                                                        | anything outside `entities/a/` (`widgets/a/`) importing a file there other than `index.ts`             |
| `no-entity-cycles`                                                                                                                       | entity `a` imports `b` and `b` imports `a` (or a longer ring), at folder level                         |
| `core-is-pure`                                                                                                                           | `core/` (specs aside) importing anything in `src/` outside `core/`, any package with `vue` in its name, or Pinia |

ESLint's `no-restricted-globals` refuses `window`, `document`, `navigator`,
`location`, `localStorage`, `sessionStorage`, `matchMedia` and
`requestAnimationFrame` in `src/core/**`, which covers the DOM half of
`core-is-pure` that an import graph cannot see.

`no-entity-cycles` uses dependency-cruiser's `scope: 'folder'`, so it sees a
ring of entities even when no ring of files exists (`a/x.ts` → `b/index.ts` →
`b/y.ts` → `a/index.ts`). A folder-level edge points at the folder of the
imported file, so it sees entities through their `index.ts`; a deep import into
an entity already fails `entity-via-index-only`.

The known-violations baseline (`make deps-baseline`) is shrink-only. It was
re-recorded in full twice: once by the move (phase 1), and once when the
module ban replaced `module-via-index-only` (renaming a rule re-keys its
entries; the only edges it added were three imports earlier phases had routed
through the `captures` and `notifications` indexes). It only shrinks from
here, and a new violation of an already-baselined rule still fails.

## Cross-cutting stores

`stores/` keeps a store only when several modules **and** the shell read it.
Confirmed against the import graph on 2026-10-29:

| Store                              | Read by                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `auth`                             | 55 groups: every module, the router, `App.vue`, `entry-server.ts`           |
| `workspaces`, `projects`           | the shell, `entry-client.ts`, `entry-server.ts`, most modules               |
| `documents`                        | the page tree: shell, editor, import, connectors, merge requests, templates |
| `events`                           | `App.vue` (the WS connection), documents, merge requests                    |
| `layout`, `sidebar`, `sidebar-nav` | the shell, plus the page chrome and the editor                              |

Feature stores live in their module's `model/`, or in an entity's when several
modules read them (the templates store, the assistant's). Two cross-cutting
stores used to call feature stores by name, which `stores-import-only-shared`
forbids. Both now take registrations instead:

- **`projects.switchProject()`** awaits `rescope()` on every project-scoped
  store. `documents` is cross-cutting and stays a direct call; a feature store
  (templates, workflows, glossary) instead calls
  `registerProjectScoped(useXStore)` (from `stores/projects`) once, at the
  bottom of its own file, and `switchProject` rescopes whatever is registered
  alongside. What is registered is the store's definition, not an instance, so
  the set is the same for every request a server renders; a store whose module
  never loaded has no instance and nothing to rescope.
- **`events`** exposes the last event as reactive state (`lastEvent`). A
  reaction that belongs to a component watches it from a component that is
  mounted while the stream is connected: `notification.created` is handled in
  `NotificationBell` (in the shell's topbar, which renders whenever the stream
  does). A reaction that belongs to a store subscribes with
  `onKnowledgeEvent(listener)` at the bottom of its file, because it has to run
  whether or not a component is mounted: the assistant store reconciles
  `assistant.turn.finished` for a thread the tab stopped watching.

## Where a new thing goes

| You are adding…                                         | Put it in                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| a page                                                  | `modules/<m>/pages/`, routed from `modules/<m>/routes.ts`    |
| a component one module uses                             | `modules/<m>/components/`                                    |
| a component several modules use, with a domain          | `entities/<d>/components/`, exported from its `index.ts`     |
| a component several modules use, without a domain       | `shared/` (`shared/layout/` for page chrome, `shared/ui/` for a primitive) |
| a composite block the shell mounts                      | `widgets/<w>/`, exported from its `index.ts`                 |
| a component the shell mounts from a module              | the module, exported from its `index.ts`                     |
| a shadcn-vue primitive                                  | `shared/ui/` (`pnpm exec shadcn-vue add` writes there)       |
| a composable for one feature                            | `modules/<m>/model/`                                         |
| a composable several modules use, with a domain         | `entities/<d>/model/`                                        |
| a composable with no domain (`useCopy`)                 | `shared/composables/`                                        |
| a feature store                                         | `modules/<m>/model/`, or `entities/<d>/model/` if shared     |
| a store the shell and several modules read              | `stores/` (and this doc's list)                              |
| an API call                                             | `modules/<m>/model/api.ts` (or the entity's), over the generated client |
| pure logic for one feature                              | `modules/<m>/model/` (or `constants/` for tables of values)  |
| pure logic with no domain                               | `core/`                                                      |
| logic the API needs too                                 | `@knowledge/contracts`                                       |
| a UI string                                             | `shared/i18n/messages/{en,ru}.json`, both locales            |

## The entity map _(planned)_

From what modules shared when the ban landed (77 files). Provisional: each
extraction phase confirms its entity's contents against the import graph.

| Entity           | From                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `document`       | **partly done:** MarkdownView, DiffView, page-refs, glossary, embeds, thread-anchors, page-source, the verification badge/ui/tone, tag-options, ActivityFeed. Still in documents: DocumentCanvas, TreeRow/TreeBranch, the verification bar, OwnerPicker, the export dialog and picker. GenerativeUiBlock and DocumentPickerWidget go to `assistant` instead (only the assistant renders them, and GenerativeUiBlock reads search and graph, which read document) |
| `search`         | **done:** use-search, app-search-source, SearchWidget with its filters, panel, results and facets, SearchSheetFrame, FacetFields; the reader and the documents search page read them. SearchSheet, ChatSearchWidget and search-ui.store stay in documents |
| `person`         | **done:** UserChip, UserCard, UserAvatar (out of `widgets/`: they read the members composable), use-members and use-agent-names, the actor helpers split out of `mr-ui`, AvatarPicker |
| `merge-request`  | merge-requests' MergeRequestList, ThreadCard, CommentComposer, thread-anchors, mr-ui                                                          |
| `rich-editor`    | **done:** RichEditor with its extensions, nodes, menus and dialogs, CollabDraftBadge, use-collab (behind `loadCollab()`), editor-streams, working-copy, use-embed-status, use-attachments, ImportStepper/ParseProgress; the module keeps EditorPage, ImportPage, the import wizard parts, CollabPresence/CollabStatus, EditorAiPanel and use-working-copy; page-source went to `document` |
| `api-operation`  | **done:** the operation embed/picker/ref/index/endpoint, ApiReferenceView and TestFixtureView (lazy), ApiChangesPanel, ApiDriftCheck, the try console and suite runner they open, api-spec, api-block-rows, schema-tree, use-operation, use-api-reference; the module keeps its pages, the fixture editor rows and QaEnvironments |
| `assistant`      | **done:** ChatPane, ChatRail, ThreadDialogs and the transcript, composer and pickers they render, thread-label, the assistant and feedback stores, AnswerFeedback, TeachAgentDialog, SourceChip, citations (the reader loads it through `loadCitations()`), GenerativeUiBlock and DocumentPickerWidget (out of documents); the module keeps the AI settings panels and AssistantPage |
| `template`       | the templates store, SaveAsTemplateDialog                                                                                                    |
| `access`         | access's PageAccessDialog, RequestAccessCard, mention-access, mcp-clients                                                                    |
| `connector`      | connectors' ConnectorRail, UsedByRail, ComponentDeclarationNotice, ConnectorList                                                             |
| `insight`        | insights' PageInsightsRail, QualityRail, ProjectAnalyticsSection, QualityDistribution, scoreTone, usePageView                               |
| `notification`   | WatchButton                                                                                                                                  |
| `capture`        | CaptureOriginParts, clientLabel, repoAtCommit                                                                                                |
| `workflow`       | **done:** WorkflowRail, the workflows store, workflow-ui. graph-theme went to `graph`, which since took the graph view too: GraphView (also as `LazyGraphView`), GraphCanvas, KnowledgeGraph, GraphControls, GraphTimeSlider, graph-model, graph-time, use-graph-time |

`DailyBars` and `AiEmptyState` have no domain and move to `shared/`.

## The module map

From the folders before the move (phase 1). `components/X` meant
`src/components/X`, a page `src/pages/<Name>Page.vue`. In each module a
`.vue` file went to `components/`, any other file to `model/`, and a subfolder
(`editor/extensions`, `editor/nodes`) whole under `components/`.

| Module           | From                                                                          | Pages                                                                                         |
| ---------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `documents`      | `knowledge`, `tree`, `graph`, `verification`                                  | DocumentsList, DocumentDetail, Search, Glossary, Conflicts, Activity                          |
| `editor`         | `editor`, `import`                                                            | Editor, Import                                                                                |
| `merge-requests` | `merge-requests`                                                              | MergeRequests, MergeRequestDetail                                                             |
| `assistant`      | `assistant`, `ai`                                                             | Assistant, AiSettings, `pages/ai`                                                             |
| `connectors`     | `connectors`, `code`, `chat-bots`                                             | Connectors, ConnectorDetail, ConnectorRun, ChatSettings, ChatLink, OauthLanding               |
| `api-reference`  | `api-reference`, `qa`                                                         | ApiSpecEditor, TestFixtureEditor, Qa, ApiSettings                                             |
| `workflows`      | `workflows`                                                                   | Workflows, WorkflowDetail, WorkflowRun, WorkflowBuilder, WorkflowWizard, WorkflowSettings     |
| `insights`       | `analytics`, `health`, `quality`                                              | Analytics, KnowledgeHealth                                                                    |
| `access`         | `access`, `security`, `profile`, `connect`, `people` (list and profile parts) | AccessControl, SecuritySettings, Profile, ProfileSettings, ConnectAi                          |
| `auth`           | —                                                                             | Login, Signup, ForgotPassword, ResetPassword, VerifyEmail, SsoComplete, Forbidden, SiteSignIn |
| `publishing`     | —                                                                             | SiteSettings, PublishingSettings, Exports, ReleasesSettings                                   |
| `reader`         | `public`                                                                      | `pages/public` (SharePage, SitePage, SiteWidget)                                              |
| `help`           | `docs`                                                                        | Docs, DocsArticle, `pages/docs`                                                               |
| `notifications`  | `notifications`                                                               | Notifications, NotificationSettings                                                           |
| `projects`       | `projects`                                                                    | Projects, ProjectDetail, ProjectOverview                                                      |
| `templates`      | `templates`                                                                   | TemplatesSettings                                                                             |
| `captures`       | `captures`                                                                    | Captures                                                                                      |
| `memos`          | `memos`                                                                       | Memos, MemoDetail                                                                             |

`reader` is the public reader (features 43–44): a second app with its own
entries (`public-main.ts`, `entry-public.ts`), its own catalogue and a
raw-`fetch` allowlist glob of its own. It started inside `publishing` and was
split out so that its entries import an index the member app never imports.

Added since #566 was filed, or missing from its map: `memos` (shipped in
v0.38.0, feature 68) is its own module; Search → `documents`; OauthLanding →
`connectors` (it lands connection OAuth, feature 69); NotificationSettings,
ProjectDetail/ProjectOverview and TemplatesSettings go with their namesakes.

Outside the modules:

| From                                                              | To                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `components/layout` (minus `page/`), `SettingsPage`, `App.vue`    | `app/` (the shell; SettingsPage is the settings shell)                                                    |
| `components/layout/page/`, `components/knowledge/RailSection.vue` | `widgets/page/` in phase 1, now `shared/layout/` — every module renders it                                |
| `people/UserChip`, `people/UserCard`, `merge-requests/UserAvatar` | `widgets/person/` in phase 1, now `entities/person`                                                        |
| `components/ui/`                                                  | `shared/ui/`                                                                                              |
| `api/`                                                            | `shared/api/`                                                                                             |
| `i18n/`                                                           | `shared/i18n/`                                                                                            |
| `router/index.ts`                                                 | `app/router/`                                                                                             |
| `style.css`, `styles/`, `assets/`                                 | `assets/`                                                                                                 |
| `lib/` pure, no domain                                            | `core/`                                                                                                   |
| `lib/use-*.ts`, `lib/rx-vue.ts`                                   | `shared/composables/`                                                                                     |
| `lib/utils.ts`                                                    | `shared/utils/cn.ts` (the shadcn-vue `utils` alias)                                                       |
| `lib/` with a domain                                              | that module's `model/`                                                                                    |

The per-file list for `lib/` is in the phase 1 PR description, which carries
the move script.

## Not in scope

- One i18n catalogue stays (`shared/i18n/messages/en.json`, `ru.json`); it is
  not split per module.
- `core/` logic does not move to `@knowledge/contracts` unless the API needs it.
- No behaviour, design or URL changes ride on any phase of this.
