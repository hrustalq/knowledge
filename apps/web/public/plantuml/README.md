# PlantUML engine (vendored)

[PlantUML](https://plantuml.com) compiled to JavaScript with TeaVM, from the
official [`@plantuml/core`](https://www.npmjs.com/package/@plantuml/core)
package. It draws UML and C4 diagrams in the browser: no Java, no server, no
`eval`, and nothing is requested from another origin.

Nothing here is edited by hand. Replace a file whole when upgrading, and update
its checksum below.

## Version

| File | Version | Source | SHA-256 |
| ---- | ------- | ------ | ------- |
| `plantuml.js` | 1.2026.10 | `@plantuml/core@1.2026.10` — <https://registry.npmjs.org/@plantuml/core/-/core-1.2026.10.tgz> (`package/plantuml.js`) | `c6664799aaa464319b5e1070a69850b93a7ea23ee41a23e920a8f2086e7da21c` |
| `viz-global.js` | 1.2026.10 (Viz.js 3.24.0) | same tarball (`package/viz-global.js`) | `fc6ca2de83dd4e3fca967d5214122777890a5cd1ab101115a1f716fc84e6dc5e` |
| `themes.js` | 1.2026.10 | same tarball (`package/themes.js`) | `6b6d2ef1590a29dfc24c1462b56dfd3b31757724da3627af5ea15dc1e991bb6d` |
| `c4.min.js` | 1.2026.10 | <https://plantuml.github.io/plantuml/js-plantuml/c4.min.js> | `455ba941efb5b1bed8de33dd2f55db53c7be0de7f86aabe04bcbc3d1024051e7` |

The tarball's `dist.integrity` is
`sha512-m67zsiUiJGAUfrk7xM2i3b9Y8HPefXder+v7STblGZgW96GUOnJTCBfJAX1d9ElDzV9d7zrEJO9S7/FHfkaGMg==`.

## What each file is for

- `plantuml.js` — the engine, an ES module exporting `renderToString(lines,
  onSuccess, onError, options)` and `render(lines, targetId, options)`. Loaded
  with a dynamic `import()` only on a page that holds a `plantuml` fence
  (`apps/web/src/shared/utils/plantuml.ts`), so it is in no initial chunk.
- `viz-global.js` — Graphviz compiled to JavaScript (Viz.js), a classic script
  that defines the global `Viz`. PlantUML uses it for graph layouts (`left to
  right direction`, `skinparam linetype ortho`, …) and fails without it, so it
  must load before the first render.
- `themes.js` — the `!theme` catalogue, defining `window.PLANTUML_THEMES`. Only
  a diagram whose source names a `!theme` needs it: the wrapper waits for it
  then, and never otherwise.
- `c4.min.js` — the C4-PlantUML standard library bundle, a classic script that
  fills `window.PLANTUML_STDLIB_JSON.c4`. `!include <C4/C4_Context>` (and
  `C4_Container`, `C4_Component`, …) fetch it through
  `window.PLANTUML_STDLIB_BASE`, which the loader sets to this directory before
  the first render — the base is a plain URL prefix and must end with `/`.

  The engine has no file system and no network: a local `!include` or a remote
  one fails with "cannot include", it is never fetched.

## Licences

- `plantuml.js`, `themes.js` and the compiled Graphviz in `viz-global.js`:
  PlantUML is MIT since 1.2026.6 — see [LICENSE](./LICENSE) (the tarball's own
  `LICENSE`). `viz-global.js` also carries Viz.js (MIT), Graphviz (EPL-1.0) and
  Expat (MIT) in its header.
- `c4.min.js` is generated from [C4-PlantUML](https://github.com/plantuml-stdlib/C4-PlantUML),
  distributed under the MIT licence.
