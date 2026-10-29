# 51 — Component pages: the code a page documents, and where it is used

Issue [#236](https://github.com/hrustalq/knowledge/issues/236), shipped as six
PRs (#243–#247 and the one carrying this document). A page could describe a
piece of code, but nothing tied the page to that code and nothing knew where
the code was used. When a pull request changed a component, the drift check
([35](35-pr-drift-check.md)) found pages tied by a `module:` link, by a file
name, or by search. It never reached the pages that describe the code's
*callers*, and those are the pages most likely to go wrong.

Now a page declares the code it documents, every codebase pull records who
imports what, and four things read that: the page's **Used by** panel, the
graph, the drift check and the knowledge-health dashboard.

## What

- **A declaration in frontmatter.** A component can be a UI component, a code
  unit or a logical component spanning several files; the page decides.

  ```yaml
  component:
    name: ResponsivePopover        # optional; else the DESCRIBES relation, else the title
    repository: owner/repo         # optional with exactly one codebase connector
    paths: [apps/web/src/shared/ui/popover/ResponsivePopover.vue]  # files, dirs (`dir/`) or globs
    symbols: [ResponsivePopover]   # optional; narrows "used" to these exports
  ```

  A declaration that resolves to no connector shows a warning on the page
  (`no-connector`, `ambiguous-repository`, `unknown-repository`, `no-paths`)
  and gets no usage data. Nothing fails silently.
- **A built-in template**, `builtin:component` (feature [42](42-page-templates.md)):
  the block above, `relations: [{ type: DESCRIBES, target: component:{{name}} }]`
  and the sections *Purpose / Public surface / Behaviour & invariants / Usage
  notes*.
- **A usage index.** Every codebase pull stores the reverse-import index of the
  connector's head (`code_imports`): for each file, which files import it and
  which names they take. It also stores the head's file list (`code_files`).
- **Derived graph edges.** A page that documents a usage site gains
  `DEPENDS_ON component:<name>` with the `code` extractor, so
  `knowledge_impact_analysis("component:<name>")` answers through code.
- **Used by.** A component page's right rail lists the files that use it and
  the pages that document each one.
- **The drift check** ties a changed file to the pages that declare it
  (`declared`, the strongest tie), adds an **Affected usages** section to its
  comment, and proposes a `component.paths` fix when a pull request deletes or
  moves a declared file.
- **Document this component.** From an undocumented usage row (web) or
  `knowledge_document_component` (MCP), the archaeologist drafts a page from
  the code into the template and opens a merge request. It never publishes.
- **Health.** The dashboard's `missing-paths` filter lists component pages
  whose declared paths match no file at the indexed head.

## The rules

All in `apps/api/src/components/component-match.ts`, with no Nest and no I/O,
because the read side, the graph rebuild, the drift check and the health
filter ask the same questions and must get the same answers.

- **Covers.** A declared path covers a file when it is the file, a directory
  above it, or a glob matching it (`**` crosses directories, `*` and `?` do
  not). `apps/api/src/bill` does not cover `apps/api/src/billing/x.ts`.
- **Used.** A file uses a component when it imports one of the component's
  files and, with `symbols` declared, takes one of them. A namespace, star or
  lazy import (`*`) counts. A default import counts for a symbol named like the
  file (`ResponsivePopover` for `ResponsivePopover.vue`). A side-effect import
  never counts. An import from inside the component's own paths is the
  component using itself.
- **Documents.** A usage site maps to the component pages whose paths cover
  it, and only when there are none, to the deepest repo-wiki module page
  ([46](46-repo-wiki.md)) containing it. A page that only mentions the file
  never counts: a mention is a claim about the text, not about the code.
- **Resolves.** `repository` matches a connector whose URL ends with it, so
  `repo`, `owner/repo` and the full URL all work. Two matches are as unusable
  as none.
- **Missing.** A declared path is missing when no file at the head answers to
  it: a file that is gone, a directory with nothing left under it, or a glob
  matching nothing. A connector never indexed with its file list reports
  nothing missing, because "unknown" is not "gone".

## Decisions

**Import-based, with a name filter.** Precise references (LSP, SCIP) would
need a per-language indexer running against a checkout. Tree-sitter already
parses every file a pull downloads, so the imports cost nothing extra; this
repository is 1,462 files and 7,659 edges in about 1.1 s.

**Barrels are folded.** Real code imports through `index.ts` re-exports, so a
naive index says everything is used by the barrel. `foldReexports`
(`connectors/adapters/import-resolver.ts`) follows `export … from` and
`export *` and stores the direct consumer → defining file edge, under the name
the defining file knows (`default` for a `.vue` re-exported as `Popover`).

**Resolution covers what a TS/JS monorepo uses**: relative imports, `tsconfig`
`paths` aliases (through `extends`) and workspace packages (`package.json`
`name` + `exports`). `.vue` and `.svelte` `<script>` blocks are parsed for the
index only. Other languages resolve relative imports only: Python relative
imports, nothing else. Python package roots and Go module paths are follow-ups.

**One head at a time.** A pull replaces `code_imports` and `code_files` whole,
in one transaction, so a reader sees one head or the next. An index failure
warns on the run and leaves the previous head's index in place; it never fails
the run.

**The declaration is a row; the edges are derived.** Ingestion records a page's
`component:` block into `component_declarations` when its default-branch head
indexes. Every codebase pull, and every change to a declaration, re-resolves
the workspace's declarations and rebuilds the `code` edges through
`GraphService.replaceCodeFacts`. Those edges are document-level, owned by that
one method and never editable; a `relations:` entry cannot claim the `code`
extractor.

**Read-time, never written.** Used by is computed per request under the
viewer's `AccessScope` and is never written into the markdown or the search
index. Anyone who can open the component page sees every usage *path* (the
code is not restricted by the knowledge base). Pages the viewer cannot open are
counted, never titled.

**Usage pages come from declared components only.** In the drift check, a
changed file that no page declares adds no usage pages. That keeps the cost at
zero for repositories without component pages. The pull request's changed files
are re-extracted at its head and overlaid on the default-branch index
(`PullRequestService.headImports`, `overlayImports`), so an importer the pull
request adds counts. Usage pages join the judged candidates under the existing
`MAX_DRIFT_PAGES`; the rest are listed, not judged.

**Drafting is an archaeologist run, not a new agent.** `ComponentDraftsService.start`
queues an archaeologist run with `input.component`; the executor's
`draftComponent` reads the files through the `code_*` tools (wrapped untrusted),
fills the template, and refuses a body that drops one of its `##` sections. The
worker only stages the draft. `ComponentDraftSweeper`, API-side, publishes it
through `AgentFindingsService.proposePage`: a head-less page behind a `newPage`
merge request with `provenance: 'agent'`. A request is refused while a
declaration already lists the path, while a run for it is in flight, while its
merge request is open, and past five pending drafts per workspace.

**Missing paths are computed on rebuild and stored.** The health dashboard is
one SQL shape ([40](40-knowledge-health.md)), and glob matching does not belong
in SQL. `ComponentsService.rebuild` reads the head's file list from `code_files`
and stores `component_declarations.missing_paths`; the filter is
`cardinality(missing_paths) > 0` over a join that ignores a declaration whose
connector is gone. `code_imports` could not answer this alone: a file that
imports nothing and is imported by nothing has no row there. The file list
includes what the archive skipped for size or for being binary, so a large or
binary declared file is not reported missing. Because a declaration change also
rebuilds, fixing `component.paths` clears the page from the filter without
waiting for the next pull.

## Surface

| What | Where |
| --- | --- |
| Tables | `code_imports`, `code_files`, `component_declarations` (`missing_paths`) |
| Rules | `components/component-match.ts` |
| Declarations, edges | `ComponentsService` (`record`, `rebuild`, `view`) in `ComponentsCoreModule` |
| Usages | `ComponentUsagesService` (`forDocument`, `forPath`, `forChange`) in `ComponentsCoreModule` |
| Drafts | `ComponentDraftsService` (`ComponentDraftsModule`), `ComponentDraftSweeper` (`ComponentsModule`, API-only), `agents/component-draft.ts` |
| Index | `CodebaseAdapter.codeImports`, `connectors/adapters/import-edges.ts`, `import-resolver.ts`, `CodeImportsService` |
| Drift | `agents/drift.ts` (`declared` tie, `componentPathFinding`), `connectors/drift/drift-report.ts` (Affected usages), `common/frontmatter.ts` (`withComponentPaths`) |
| Health | `HEALTH_FILTERS` (`missing-paths`), `healthFilterSql`, `KnowledgeHealthRow.missingPaths` |

| Route | Access |
| --- | --- |
| `GET /v1/documents/:id/component` | viewer, the page |
| `GET /v1/documents/:id/component/usages` | viewer, the page |
| `GET /v1/code-usages?workspaceId=&path=&repository=` | viewer, the workspace |
| `POST /v1/components/drafts` | editor, `202` |

| MCP tool | Guard |
| --- | --- |
| `knowledge_code_usages({ path \| documentId, symbols? })` | viewer; read tool |
| `knowledge_document_component({ workspaceId, paths, connectorId?, symbols?, name?, projectId?, parentId? })` | editor; in `WRITE_TOOLS`, hidden from read-only keys |
| `knowledge_impact_analysis("component:<name>")` | unchanged; now walks `code` edges too |

Web: `modules/connectors/components/UsedByRail.vue` (the panel, and **Document** on an
undocumented row for editors), `ComponentDeclarationNotice.vue` (the warning,
and the missing paths), `ComponentDraftStatus.vue` (polls the run until its
merge request exists), and the **Missing code** preset with a per-row chip on
the health page.

## Operations

- Migrations `20261030100000_code_imports`, `20261031100000_component_declarations`,
  `20261101100000_agent_run_details` and `20261102100000_component_missing_paths`
  are additive. The previous release ignores them, so a rollback is safe.
- Nothing is backfilled. Declarations fill as pages next index; the index, the
  file list and `missing_paths` fill on each codebase connector's next pull.
- No new env var.

## Deliberate deferrals

- LSP/SCIP references. v1 is import-based with a name filter.
- Python package roots and Go module paths.
- Proactive gap findings ("a heavily imported file with no component page").
- Branches other than the default, beyond the pull request overlay.
- Writing usage lists into page markdown or the search index.

## Verification

- Specs: `code-imports.spec.ts` (resolver, barrels, file list),
  `component-declarations.spec.ts`, `component-usages.spec.ts` (non-admin
  viewer counts hidden pages), `component-drift.spec.ts` (overlay, cap, path
  fixes), `component-draft.spec.ts`, `component-health.spec.ts`.
- Live on dev, phase by phase. Phase 1: this repository's index lists
  `packages/contracts/src/core/index.ts`'s importers from `apps/api` and
  `apps/web`. Phase 4: the pipeline ran on merged #226 without a model. Phase 5:
  the sweeper opened a hand-inserted run's draft as a hidden page and merge
  request. Phase 6: a page declaring a real and a deleted file showed under
  **Missing code** with one missing path, and so did an older page whose
  declared file had moved to `ui/popover/`.
- Not checked live: a real webhook → GitHub comment, a model filling a draft
  (no usable model locally), and a full codebase pull after phase 6. The file
  list was seeded from `git ls-tree origin/dev` instead, because a pull would
  restage the wiki and spend model calls.
