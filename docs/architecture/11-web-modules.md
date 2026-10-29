# 11 — The web app's layers and modules

## What this is

`apps/web/src` is organized by **layer**, and inside the `modules` layer by
**feature**. A feature's page, components, composables, store and API calls
live in one folder, and dependency-cruiser enforces which folder may import
which (#566).

This replaces the by-file-type layout (`components/`, `pages/`, `lib/`,
`stores/`, `api/`, `router/`), where one feature lived in four trees and
nothing stopped features reaching into each other: `components/knowledge`
imported from nine sibling feature folders, and folder-level cycles such as
`knowledge` ↔ `merge-requests` and `assistant` → `merge-requests` → `ai` →
`assistant` went unnoticed because the old rules only knew about file-level
cycles.

> **Status.** Phases 0 (the rules) and 1 (the move) have landed: every file is
> in its layer or module, and the 263 violations the move surfaced are in the
> baseline. No module has an `index.ts` yet, so every cross-module import is
> one of them. Each later phase gives one module its `index.ts` and
> `routes.ts`, untangles it and shrinks the baseline, leaves first (`help`,
> `captures`, `notifications`, …, `documents` last). Sections marked
> _(planned)_ describe the end state, not the tree today.

## The layers

Left may import right, never the reverse. A layer may import itself.

```
app → modules → widgets → stores → shared → core        assets/ from anywhere
```

| Layer      | Holds                                                                                                                                                             | May import                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `app/`     | `App.vue`, the shell (sidebar, topbar, breadcrumbs, switchers, the settings shell), app-wide composables and providers, `app/router/`                             | everything below; modules by index                                   |
| `modules/` | one folder per feature (the map below)                                                                                                                            | widgets, stores, shared, core; another module only by its `index.ts` |
| `widgets/` | blocks used by two or more modules that own no route and belong to no domain (the widget test below)                                                              | stores, shared, core                                                 |
| `stores/`  | cross-cutting Pinia stores only (the list below)                                                                                                                  | shared, core                                                         |
| `shared/`  | business-agnostic: `api/` (generated client, `schema.d.ts`, query helpers), `composables/`, `constants/`, `types/`, `utils/`, `ui/` (the shadcn-vue kit), `i18n/` | core                                                                 |
| `core/`    | pure TypeScript: no Vue, no Pinia, no DOM, nothing from `src/` outside `core/`                                                                                    | `@knowledge/*` packages only                                         |
| `assets/`  | static assets and global styles (`style.css`, `styles/`)                                                                                                          | —                                                                    |

The entry files stay at the `src/` root, above `app/`: `main.ts`,
`entry-client.ts`, `entry-server.ts`, `public-main.ts`, `entry-public.ts`,
`entry-public-client.ts`, `export-render.ts`, `sw.ts`. `index.html`,
`reader.html`, `server.js` and `vite.config.ts` load them by path. They import
modules only by `index.ts`, like `app/` does.

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
  routes.ts     its routes, each page a lazy import()
  index.ts      its public surface
```

- **`index.ts` is the only door.** Explicit named exports, never `export *`,
  and always `routes`. A page, a component or a store that another module
  needs is exported here; everything not exported is private, and the module's
  own PR may move it freely.
- **`model/api.ts`** holds the module's query keys, `apiQueryOptions` and
  mutation wrappers over the generated client. No hand-written HTTP: the
  `fetch(` ban and its allowlist in `apps/web/eslint.config.js` still apply.
- **`routes.ts`** exports the module's `RouteRecordRaw[]` _(planned)_.
  `app/router` only concatenates them. A module whose pages nest under the
  settings shell exports `settingsRoutes` beside `routes`, and `app/router`
  mounts those under `/settings`.
- A feature store is `model/<name>.store.ts` (`templates.store.ts`), so it
  never collides with the plain helper of the same name (`templates.ts`).
- Folders a module does not need are not created. `help` carries one more,
  `help/docs/`: the articles, globbed by `registry.ts`, and the generated
  reference.

## The import rules

| Rule (`.dependency-cruiser.cjs`)                                                                                | Fails on                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `modules-import-no-app`, `widgets-import-no-module`, `stores-import-only-shared`, `shared-is-business-agnostic` | any import pointing left in the layer line                                                            |
| `core-is-pure`                                                                                                  | `core/` importing anything in `src/` outside `core/`, or any package with `vue` in its name, or Pinia |
| `module-via-index-only`                                                                                         | `modules/a/**` importing `modules/b/**` other than `modules/b/index.ts`                               |
| `app-via-module-index`                                                                                          | the same, from `app/` or an entry file                                                                |
| `no-module-cycles`                                                                                              | `a` imports `b` and `b` imports `a` (or a longer ring), at folder level                               |

ESLint's `no-restricted-globals` refuses `window`, `document`, `navigator`,
`location`, `localStorage`, `sessionStorage`, `matchMedia` and
`requestAnimationFrame` in `src/core/**`, which covers the DOM half of
`core-is-pure` that an import graph cannot see.

`no-module-cycles` uses dependency-cruiser's `scope: 'folder'`, so it sees a
ring of modules even when no ring of files exists: `a/x.ts` → `b/index.ts` →
`b/y.ts` → `a/index.ts` is no file cycle and is a module cycle. Break one by
moving the shared piece down (a widget, `shared/`, `core/`), or by inverting the
call: the module that needs to be told something registers a callback, or
listens to an event, instead of being called by name.

It sees modules through their `index.ts` only: a folder-level edge points at
the folder of the imported file, so a deep import (`a` → `b/components/X.vue`)
lands on `b/components`, not on `b`. A ring made of deep imports is therefore
invisible to it, but every edge of that ring already fails
`module-via-index-only`. The cycle surfaces in the phase that routes the second
side through an `index.ts`, and that phase breaks it.

The known-violations baseline (`make deps-baseline`) stays shrink-only. Phase 1
re-records it once, with every violation the new layout has; from then on it
only shrinks, and a new violation of an already-baselined rule still fails.

## The widget test

A block is a **widget** when all three hold:

1. two or more modules use it;
2. it owns no route;
3. it belongs to no single domain.

Person avatar + hover card, the filter rail, the search box and the page chrome
(`PageLayout`, `PageRail`, `PageState`, `RailSection`, …) are widgets. A block
with a domain is an **export of its module** even when every other module uses
it: `RichEditor` belongs to `editor`, an MR chip to `merge-requests`, the
verification badge to `documents`. The test for "has a domain" is whether it
would have to change when that domain's rules change.

A widget never imports a module. One that needs to is a module export.

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

Moved to a module's `model/`, against the issue's starting list:

| Store                   | Module          | Why                                                                                                                           |
| ----------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `search-ui`             | `documents`     | It drives the search sheet and imports `use-search`, which is documents' own; the shell reaches it through `documents`' index |
| `glossary`, `page-refs` | `documents`     | Only documents reads them                                                                                                     |
| `templates`             | `templates`     | Exported from its index for editor, import and workflows                                                                      |
| `workflows`             | `workflows`     |                                                                                                                               |
| `notifications`         | `notifications` |                                                                                                                               |
| `assistant`, `feedback` | `assistant`     |                                                                                                                               |

Two cross-cutting stores call feature stores by name today, which
`stores-import-only-shared` forbids. Each is an inversion, done in the phase of
the module it reaches:

- **`projects.switchProject()`** calls `rescope()` on `documents`, `glossary`,
  `workflows` and `templates`. It will expose a project-switch hook that a
  project-scoped store subscribes to when it is created. A store nobody created
  has nothing to rescope, so it loses nothing by not being called (and today it
  is instantiated just to be told).
- **`events`** dispatches into `assistant` and `documents`, and did into
  `notifications`. It already exposes the last event as reactive state
  (`lastEvent`), so no registry is needed: the module that owns the reaction
  watches `lastEvent` from a component that is mounted while the stream is
  connected. `notification.created` moved into `NotificationBell` (in the
  shell's topbar, which renders whenever the stream does) this way.

## Where a new thing goes

| You are adding…                                   | Put it in                                                   |
| ------------------------------------------------- | ----------------------------------------------------------- |
| a page                                            | `modules/<m>/pages/`, routed from `modules/<m>/routes.ts`   |
| a component one module uses                       | `modules/<m>/components/`                                   |
| a component several modules use, with a domain    | its module's `components/`, exported from `index.ts`        |
| a component several modules use, without a domain | `widgets/`                                                  |
| a shadcn-vue primitive                            | `shared/ui/` (`pnpm exec shadcn-vue add` writes there)      |
| a composable for one feature                      | `modules/<m>/model/`                                        |
| a composable with no domain (`useCopy`)           | `shared/composables/`                                       |
| a feature store                                   | `modules/<m>/model/`                                        |
| a store the shell and several modules read        | `stores/` (and this doc's list)                             |
| an API call                                       | `modules/<m>/model/api.ts`, over the generated client       |
| pure logic for one feature                        | `modules/<m>/model/` (or `constants/` for tables of values) |
| pure logic with no domain                         | `core/`                                                     |
| logic the API needs too                           | `@knowledge/contracts`                                      |
| a UI string                                       | `shared/i18n/messages/{en,ru}.json`, both locales           |

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
| `publishing` | — | SiteSettings, PublishingSettings, Exports, ReleasesSettings |
| `reader` | `public` | `pages/public` (SharePage, SitePage, SiteWidget) |
| `help`           | `docs`                                                                        | Docs, DocsArticle, `pages/docs`                                                               |
| `notifications`  | `notifications`                                                               | Notifications, NotificationSettings                                                           |
| `projects`       | `projects`                                                                    | Projects, ProjectDetail, ProjectOverview                                                      |
| `templates`      | `templates`                                                                   | TemplatesSettings                                                                             |
| `captures`       | `captures`                                                                    | Captures                                                                                      |
| `memos`          | `memos`                                                                       | Memos, MemoDetail                                                                             |

`reader` is the public reader (features 43–44): a second app with its own
entries (`public-main.ts`, `entry-public.ts`), its own catalogue and a raw-`fetch`
allowlist glob of its own. It started inside `publishing` and was split out in
its phase so that its entries import an index the member app never imports,
and the member app's imports of `publishing` never pull reader views in.

Added since #566 was filed, or missing from its map: `memos` (shipped in
v0.38.0, feature 68) is its own module; Search → `documents`; OauthLanding →
`connectors` (it lands connection OAuth, feature 69); NotificationSettings,
ProjectDetail/ProjectOverview and TemplatesSettings go with their namesakes.

Outside the modules:

| From                                                              | To                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `components/layout` (minus `page/`), `SettingsPage`, `App.vue`    | `app/` (the shell; SettingsPage is the settings shell)                                                    |
| `components/layout/page/`, `components/knowledge/RailSection.vue` | `widgets/page/` — every module's page chrome, so in `app/` it would be an upward import from every module |
| `people/UserChip`, `people/UserCard`, `merge-requests/UserAvatar` | `widgets/person/` — the person avatar and hover card |
| `components/ui/`                                                  | `shared/ui/`                                                                                              |
| `api/`                                                            | `shared/api/`                                                                                             |
| `i18n/`                                                           | `shared/i18n/`                                                                                            |
| `router/index.ts`                                                 | `app/router/`                                                                                             |
| `style.css`, `styles/`, `assets/`                                 | `assets/`                                                                                                 |
| `lib/` pure, no domain                                            | `core/`                                                                                                   |
| `lib/use-*.ts`, `lib/rx-vue.ts`                                   | `shared/composables/`                                                                                     |
| `lib/utils.ts`                                                    | `shared/utils/cn.ts` (the shadcn-vue `utils` alias)                                                                                           |
| `lib/` with a domain                                              | that module's `model/`                                                                                    |

The per-file list for `lib/` is in the phase 1 PR description, which carries
the move script.

## Not in scope

- One i18n catalogue stays (`shared/i18n/messages/en.json`, `ru.json`); it is
  not split per module.
- `core/` logic does not move to `@knowledge/contracts` unless the API needs it.
- No behaviour, design or URL changes ride on any phase of this.
