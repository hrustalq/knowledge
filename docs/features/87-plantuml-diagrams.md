# 87: PlantUML diagrams

Issue [#1388](https://github.com/hrustalq/knowledge/issues/1388).

## What

A page can hold a [PlantUML](https://plantuml.com) diagram in a ```` ```plantuml ```` fence. Everything PlantUML
draws works — use case, component, class, sequence and the rest of UML — and so does C4-PlantUML, whose model is
written with `!include <C4/C4_Context>` and friends.

- **Read view.** The fence becomes the drawing, centred like a mermaid diagram, with the same size and placement
  (`width=`, `wrap=`) in the info string. It opens in the diagram lightbox full screen. Creole links in labels
  (`[[https://…/documents/<id>#anchor Label]]`) stay links, so a use-case oval leads to the page that describes it.
- **Editor.** The block draws live, its source behind **Edit source** (the same two-pane view mermaid has), an error
  report in place while you type, and the last good drawing kept on screen. **PlantUML diagram** sits beside
  **Mermaid diagram** in the insert menu and the slash menu.
- **Share links and published sites.** The server sends the fence and its layout; the reader's browser draws it.
- **Exports.** The HTML bundle and the PDF ship the engine and draw every block before the page is printed.

## Decisions

The issue left the engine open. We chose the official `@plantuml/core`, PlantUML compiled to JavaScript with TeaVM.
That is MIT since 1.2026.6, runs in the browser, and needs no Java.

| Option | Why not / why |
| ------ | ------------- |
| A `plantuml-server` container | The real thing, and every language feature works — but it is Java, another service to run, upgrade and secure, and every diagram becomes a round trip whose bytes we then have to sanitize anyway. |
| Converting PlantUML to mermaid or Structurizr | Both draw a fraction of what PlantUML does (C4-PlantUML has no equivalent in either), and a converter that is wrong is worse than a fence that does not draw: the source would silently become a different diagram. Structurizr has its own fence ([85](85-c4-diagrams.md)), which stays the better choice for a model with drill-down. |
| **`@plantuml/core`** | The reference implementation itself, so what the reader sees is what PlantUML draws. No server, no Java, no `eval`. Two honest limits: the engine is ~3 MB, and a diagram that needs a bundled stdlib fetches it from us. |

- **Lazy.** The engine is fetched only by a page that holds a `plantuml` fence, with a dynamic `import()` of a
  runtime URL. No app module imports it statically, so it is in no initial chunk and no page pays for it unless it
  draws.
- **Self-hosted, and only self-hosted.** `plantuml.js`, `viz-global.js` (Graphviz/Viz.js), `themes.js` and the C4
  stdlib bundle `c4.min.js` are vendored in `apps/web/public/plantuml/` with version, source URLs, licence and
  checksums ([its README](../../apps/web/public/plantuml/README.md)). The engine has no network of its own: a local or
  remote `!include` fails rather than being fetched. The one request it can make is the stdlib `<script>`, resolved
  against `window.PLANTUML_STDLIB_BASE`, which we point at our own directory.
- **A stdlib is a script, not text.** `!include <C4/C4_Context>` makes the engine append a `<script>` for the bundle
  the include names. Self-hosting it is therefore a directory of classic scripts next to the module, not an npm
  package import.

## How

- **The fence.** `@knowledge/editor-schema` learns `plantuml` next to `mermaid` and `drawing`: the markdown renderer
  emits `<div data-kn-plantuml="1" …layout><pre>source</pre></div>`, the serializer writes the fence back with its
  layout in the info string, and the schema gains a `knPlantuml` node cloned from `knMermaid`. The sanitize allowlist
  keeps the attribute, so the block survives every surface that renders someone else's markdown, untrusted ones
  included. Source and round trip are pinned in `markdown-roundtrip-collab.spec.ts` and `sanitize.spec.ts`.
- **The engine wrapper** is `apps/web/src/shared/utils/plantuml.ts`:
  - one singleton loader: set `PLANTUML_STDLIB_BASE`, inject `viz-global.js` as a classic script (Graphviz must be
    there before the first layout), then import the module;
  - renders are queued in call order, one at a time, with the dark flag each was asked for;
  - a failed load is not remembered, so the next diagram tries again.
- **An error is an SVG.** PlantUML does not reject on bad syntax: it *returns* a drawing of the error, its text in
  `#33FF02`. That colour is the engine's own error constant, so the wrapper recognises the output and throws a
  `PlantumlError` carrying the line (`[From textarea (line 2)]`) and PlantUML's wording. Every surface then treats it
  as mermaid treats a parse error: the source stays, flagged; the rest of the page is untouched.
- **Read view.** `MarkdownView` and the reader's `PublicMarkdown` mirror `renderMermaid()` — sanitize with the SVG
  profile (`sanitizeUntrustedSvg` for model output), `carryDiagramLayout`, `.kn-plantuml-figure`. A failure adds
  `.kn-plantuml-broken`, which is the mermaid broken state's styling.
- **Dark mode.** `renderToString(…, { dark })`, as mermaid is re-rendered on a theme change: boxes come out `#222222`
  with white text, so a diagram is readable on the app's dark surface.
- **Exports.** `export-render.ts` ships `plantuml-global.js`, `viz-global.js` and `c4.min.js` beside the pages only
  when one holds a fence. `plantuml-global.js` is the vendored module with its single `export {…}` statement turned
  into `window.PlantUML = {…}`: an ES module cannot load from `file://`, where an HTML bundle is opened. Each page
  sets its own `PLANTUML_STDLIB_BASE` (a page in a subfolder needs `../_static/plantuml/`), and one coordinator
  raises the PDF print-ready flag only after every mermaid **and** PlantUML render has settled — with a 30 s ceiling,
  as before.
- **Lightbox.** `.kn-plantuml-figure` joins the diagram selector, so a drawing opens full screen and a broken block
  opens nothing.

## Not done

- PlantUML's own server-side includes: a diagram that names a URL or a local file draws an error (the engine has no
  file system and no network by design).
- The sprite libraries PlantUML ships separately (AWS, Kubernetes, Azure…) and `!theme` names outside the vendored
  `themes.js`: the engine draws an error for a theme it does not know.
- Server-side rendering: the drawing happens in the browser, as mermaid's does, so a reader without JavaScript sees
  the source.
- A size cap beyond the engine's own `maxSvgSize` (8192 px), which makes an oversized diagram fail rather than
  freeze the tab.
