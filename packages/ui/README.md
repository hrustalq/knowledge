# @knowledge/ui

The UI kit (shadcn-vue components, one export per folder) and the page chrome
(`./layout`) shared by the apps in this monorepo.

**The rule:** a component lives here when it has no domain. It imports nothing
from an app, and whatever an app must supply reaches it by prop, slot or
inject. The background is in
[docs/architecture/11](../../docs/architecture/11-web-modules.md#the-ui-package).

The package is buildless and consumed from source **by Vite only**. Its files
import each other relatively, so no Node process (an API, a worker, an
unbundled `server.js`) can import it.

## Using it from an app

`apps/web` is the working example; the paths below are where it does each step.

### 1. Depend on it

```jsonc
// apps/<app>/package.json
"dependencies": {
  "@knowledge/ui": "workspace:*",
  "vue": "^3.5.32",
  "vue-i18n": "^11.4.10",
  "vue-router": "^4.5.1"
},
"devDependencies": {
  "@tailwindcss/vite": "^4.1.0",
  "tailwindcss": "^4.1.0"
}
```

`vue`, `vue-router`, `vue-i18n` and `tailwindcss` are peers: the app installs
them, at the same versions as `apps/web`, so there is one copy of each. Add the
package's manifest to the app's Dockerfile `COPY` lists, as `Dockerfile.web`
does.

### 2. Import the stylesheet

```css
/* apps/web/src/assets/style.css */
@import "tailwindcss";
@import "@knowledge/ui/theme.css";
```

`theme.css` brings the palette (`tokens.css`, light and `.dark`), the `dark`
variant, the Tailwind theme the kit's classes are written against,
`tw-animate-css`, and an `@source` line that makes the kit's classes exist in
your build. Dark mode is the `dark` class on an ancestor, normally `<html>`.

`@knowledge/ui/tokens.css` is also exported on its own, for something that
needs the colours without Tailwind (`apps/web/src/export-render.ts` inlines it
with `?raw`).

### 3. Merge the `ui` catalogue

The kit's strings are `ui.*` keys in `src/messages/en.json` and `ru.json`.
Merge the active locale's file into your vue-i18n messages:

```ts
// apps/web/src/shared/i18n/catalog.en.ts — one chunk per language
import app from './messages/en.json'
import ui from '@knowledge/ui/messages/en.json'

export default { ...app, ...ui }
```

`apps/web/src/public-main.ts` does the same for an app that ships both
languages statically. Your own code never reads a `ui.*` key.

### 4. Provide what the page chrome injects

Only if you render `@knowledge/ui/layout`. At the app root
(`apps/web/src/app/App.vue`):

```ts
import { provide } from 'vue'
import { ERROR_TEXT, RAIL_MEMORY } from '@knowledge/ui/layout'

// Required by PageRail: which rail widgets are open, per surface.
// { openWidgets(surface): string[] | null; setWidgetOpen(surface, id, open, current): void }
provide(RAIL_MEMORY, useLayoutStore())

// Optional: what PageState says for a thrown value. Without it, the error's own message.
provide(ERROR_TEXT, (error) => errorMessage(error, t))
```

The chrome also expects a `vue-router` instance: `usePageTabs` binds a tab to
`?tab=`, `PageRail` opens the widget the URL names, and a `canvas` page's route
must declare `meta: { fill: true }` (`PageLayout` warns in dev when the two
disagree; the `RouteMeta.fill` type comes with the import).

### 5. Render

```vue
<script setup lang="ts">
import { Button } from '@knowledge/ui/button'
import { PageLayout } from '@knowledge/ui/layout'
</script>

<template>
  <PageLayout variant="list" title="People">
    <template #actions><Button>Invite</Button></template>
    …
  </PageLayout>
</template>
```

Other entries: `@knowledge/ui/cn` (`cn`, `nativeEl`) and
`@knowledge/ui/use-hydrated` (`useHydratedMediaQuery`).

## Working in it

| Task                  | How                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Add a shadcn-vue part | `pnpm exec shadcn-vue add <name>` here. It writes `src/<name>/`; then fix its `cn` import to `../cn` and drop the bogus `cn` dependency it adds (`CLAUDE.md`, Gotchas). The `./*` export covers the new folder. |
| Add a string          | `src/messages/en.json` **and** `ru.json`, under `ui.`. `messages.spec.ts` fails an unknown key, an unread key and a missing translation. |
| Show a date or number | Take the formatted text, or a formatter, as a prop (`DailyBars`' `dayLabel`). ESLint refuses `new Intl.*` and a locale-less `toLocale*()` here: the app decides the locale. |
| Need app state        | Declare an injection key beside `RAIL_MEMORY` in `src/layout/page-chrome.ts`; the app provides it.      |
| Check                 | `pnpm --filter @knowledge/ui run typecheck`, `lint`, `test`, `depcruise` (all part of `make verify`).   |

`depcruise` (`.dependency-cruiser.cjs`) fails an import of anything under
`apps/` or of another `@knowledge/*` package.
