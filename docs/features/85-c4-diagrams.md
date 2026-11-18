# 85: C4 diagrams

Issue [#1244](https://github.com/hrustalq/knowledge/issues/1244).

## What

A page can hold a C4 model written in [Structurizr DSL](https://docs.structurizr.com/dsl) in a ```` ```structurizr ````
fence. One model holds several views, for example a system context, the system's containers and one container's
components.

- **Two tabs.** Each block has two tabs: **Diagram** and **Source**. In the editor the Source tab is the code block
  itself.
- **Zoom in.** The Diagram tab shows one view at a time. An element that has a view of its own is outlined in the
  accent colour. Clicking it, or pressing Enter on it, opens that view. The drawing grows out of the element, and the
  next level settles in.
- **Zoom out.** The trail above the drawing (`Shop · System context › Shop · Containers › API · Components`) leads
  back up.
- **Pan and zoom in place.** Use Ctrl or a pinch with the wheel, the − / % / + buttons, or drag once zoomed. A plain
  wheel still scrolls the page.
- **Full screen.** The last button opens the model full screen. On a page it opens for exploring. In the editor it
  opens the **builder**:
  - Add elements from a palette by clicking or dragging.
  - Drag an element to move it.
  - Drag the dot on an element's edge onto another element to connect them.
  - Edit names, descriptions, technology and the External / Database tags in an inspector.
  - Open or create the level below.
  - Use the keyboard for all of it: Tab, the arrow keys, Delete, Enter, ⌘Z and ⌘⇧Z.

  The URL carries `?c4=<n>&view=<v>`, so Back closes the full-screen view and a link opens it.
- **Starting a model.** The slash menu and the toolbar's insert menu have **C4 diagram**, which starts a model: a
  person using a system.

```structurizr
workspace {
  model {
    user = person "Customer" "Buys things"
    shop = softwareSystem "Shop" {
      web = container "Web" "Storefront" "Vue"
      api = container "API" "Orders and payments" "NestJS" {
        orders = component "Orders" "Takes orders"
        payments = component "Payments" "Charges cards"
        orders -> payments "Charges"
      }
      db = container "Database" "Orders" "PostgreSQL" "Database"
      web -> orders "Places orders" "REST"
      orders -> db "Writes"
    }
    user -> web "Shops"
  }
  views {
    systemContext shop { include * }
    container shop {
      include *
      // @layout user 0 0, web 0 250, api 310 250, db 620 250
    }
    component api { include * }
  }
}
```

## Decisions

The issue left three engines open. We chose **Structurizr DSL, parsed by us**:

| Option                         | Why not / why                                                                                                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mermaid `C4Context` / `C4Container` | Already bundled, but Mermaid's C4 support is experimental: boxes sit on a fixed grid and relationship labels overlap. Each diagram is separate, so there is no model shared across views, and drill-down would still be our own layer.                                       |
| LikeC4 as a React island       | Real `navigateTo` drill-down and good layout, but `@likec4/diagram` brings React, xyflow, a Langium parser and Graphviz WASM (several MB) into a Vue app. The public reader and export would still need their own static path.                                                     |
| **Structurizr DSL**            | The format of the reference talk and of Structurizr's own tooling. A model written here opens in Structurizr, and one from Structurizr draws here. No new dependency.                                                                                                              |

A view with no stored layout is drawn by Mermaid as a flowchart: dagre lays it out, and the SVG goes through the same
sanitize profile as every Mermaid diagram. A view its author arranged in the builder is drawn by our own SVG renderer
at the stored positions.

**Positions live in the DSL**, as a `// @layout id x y, …` comment inside the view. It stays in the same fence,
round-trips through the editor, and Structurizr's tools read past it as a comment. A separate layout fence was
rejected because the two blocks could drift apart. Positions are a comment because DSL views have no place for
coordinates.

**The builder edits text, never regenerates it.** Every action changes the DSL in place at the line and column the
parser recorded, so an author's formatting, comments, styles and anything else this app does not read survive a
visual edit. What it cannot change safely (a statement sharing its line with another) it refuses with a message
rather than guess.

## How

- **Parser.** `core/markdown/structurizr.ts` is pure, so it runs on the server for export too. `parseStructurizr`
  reads the subset:
  - `person`, `softwareSystem`, `container` and `component`, nested as C4 nests them;
  - `->` relationships, including an implicit or `this` source inside an element;
  - `group` blocks;
  - the `description` / `technology` / `tags` properties;
  - `systemContext`, `container` and `component` views with `include` / `exclude` / `autoLayout` / `title` and the
    `// @layout` line.

  Everything else (styles, themes, deployment, properties, `!identifiers`) is skipped, so a full Structurizr
  workspace still draws. With no `views` block, the model gets one view per level it has. A syntax error is a
  `C4SyntaxError` with a line number. Every element, relationship and view keeps its place in the source as `src`.
- **Views.** `viewElements` follows Structurizr's `include *`: the view's own elements, plus whatever is directly
  connected to them, with each relationship lifted to the level the view draws (`viewRelationships`). A component of
  another system is drawn as that system. A relationship to a container, not to one of its components, is not in
  that container's component view, as in Structurizr. `detailViewOf` is the drill-down link: the container view of a
  system, or the component view of a container.
- **Two renderers, one palette.**
  - `viewToMermaid` writes a `flowchart`. Node ids are `c4n<i>`, which Mermaid writes into each node's `<g id>`.
    Every label is a quoted string, so `"` becomes `'` and `<` / `>` become `‹` / `›`: look-alike characters, not
    entities, because Mermaid decodes `#…;` in node labels only.
  - `core/markdown/c4-svg.ts` draws laid-out views: fixed-size boxes, as Structurizr's are, so no text is measured
    and the server and browser draw the same picture. `autoLayout` (longest-path rows) is where the builder starts a
    view that has no layout.

  Both draw from `C4_PALETTE` (Structurizr's default C4 colours, with systems out of scope in grey).
  `entities/document/model/c4-draw.ts` picks the renderer and sanitizes. `nodeAt` finds the element under a pointer
  in either drawing.
- **Edits.** `core/markdown/structurizr-edit.ts` holds the builder's operations, pinned in its spec:
  `addElement`, `connectElements`, `updateElement`, `updateRelationship`, `deleteElement`, `deleteRelationship`,
  `placeElements`, `clearLayout` and `addDetailView`.
  - `withIds` first gives every anonymous element an `id =`, so ids never change under an edit.
  - Views are named by index.
  - A view the model showed only by default is written out into a `views` block before it is changed, and a one-line
    view block is opened onto lines.
  - An element added where its view would not show it by itself is also `include`d by name.
  - Deleting an element takes everything inside it, every relationship to or from it, and the views about it.
- **Reader.** `C4Diagram` (entities/document) holds the tabs, trail, drill-down and pan/zoom. Read surfaces call
  `takeC4Blocks`, which swaps each `pre > code.language-structurizr` for a host, and teleport a C4Diagram into it.
  `MarkdownView` (comments, chat, help) and the public reader's `PublicMarkdown` do this, and their full-screen view
  explores only. The zoom is the Web Animations API, skipped under `prefers-reduced-motion`. Pan and zoom are
  `usePanZoom` from `@knowledge/ui/lightbox`.
- **Editor.** The fence stays an ordinary code block, so the source round-trips byte for byte. That is pinned in
  `markdown-roundtrip-collab.spec.ts`, and nothing changes in `@knowledge/editor-schema` or the schema version.
  - `withC4CodeBlocks` (`extensions/c4.ts`) re-extends the code block `baseExtensions` configures, keeping its
    options. It adds a node view for `structurizr` blocks only, plus the `setC4` insert command; every other code
    block keeps the schema's own DOM.
  - The page itself reads through the read-only editor, so this node view also draws the model on a page.
  - **Full screen belongs to the editor (`C4StudioHost`, one per editor), not to the block.** ProseMirror may
    rebuild a node view whenever it likes. A full-screen dialog owned by one was rebuilt with it and, since the URL
    still said open, mounted again in an endless loop.

    The block's button now only writes `?c4=<n>&view=<v>`. The host finds the n-th C4 block by position, reads its
    text on every transaction, and writes the builder's text back in one transaction. Undo, autosave and
    collaboration see an ordinary edit, and ⌘Z in the builder is the editor's undo.
- **Search.** Ingestion chunks the raw markdown, fence included, so element names and descriptions are indexed like
  any other text, and `@layout` lines are only a few short tokens. Published-site search keeps every fence except
  `mermaid`.
- **Public reader.** The server sends the source as a code block, and the browser makes it explorable as in the app.
  With JavaScript off, the reader sees the source.
- **Export.** `renderPublicMarkdown(…, { staticC4 })` replaces each model with every view, each under its title:
  - a laid-out view as its SVG, drawn on the server;
  - any other view as a Mermaid block, which the export's existing script draws.

  A model that does not parse stays its source. DOCX keeps the source as a code block.

## Not done

- The rest of Structurizr: `systemLandscape`, dynamic, deployment and filtered views, element styles and themes,
  `!include`, and hierarchical identifiers beyond `a.b` lookups.
- Routing arrows around boxes in a laid-out view: they are straight, centre to centre.
- Renaming an element's id when its name changes: the id is the name it was first given.
- Generating models from code. That is possible later through the repo wiki ([46](46-repo-wiki.md)).
