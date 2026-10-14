# 46 — Repo wiki

A `codebase` connector (feature 27) documents a repository as a hub and a list
of modules. The repo wiki gives the same derivation a wiki's shape: an
overview, then Architecture, Data flow and an optional Public API page, then
the module pages. The repository steers it from a file it carries,
`.knowledge/wiki.yml`.

It is an option on the connector, not a new connector kind. The connector's
**Repo wiki** setting (`config.wiki = 'on'`) turns it on. Off is the default,
and with it off the sync output is exactly what feature 27 produced.

## Units, and why the old keys stay

| `externalId`        | page                                                           | version hashes                                         |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| `overview` (kept)   | the hub: a section index, then modules, languages, entrypoints | manifests + README + module list + sections + steering |
| `wiki:architecture` | components, how the modules depend on each other               | manifests + module names/entrypoints + steering        |
| `wiki:data-flow`    | one entry per flow: its entry file, signatures, what it imports | each flow's entry file + the flow list + steering      |
| `wiki:api`          | exported symbols by module                                     | exported signatures only + steering                    |
| `module:<path>` (kept) | one per module, unchanged                                   | the module's files + steering                          |

`overview` and `module:<path>` are **kept, never renamed**. They are
`connector_links` keys, and renaming one would orphan every live link and
duplicate the page. New sections are new keys (`wikiUnitKey`, contracts).
`children()` hangs every section and module under `overview`.

Each section's version covers only what that section prints, so a change
re-derives exactly the pages it can affect:

- A function body edited inside module A moves `module:A` and nothing else. The
  architecture page hashes manifests and the module list, not source bytes. It
  lists modules by path rather than by size, so a module that merely grew does
  not move it.
- The API page hashes exported signatures, walked in module-key order. Renaming
  a private helper does not move it.
- The steering file's hash and the applied effort are mixed into every wiki
  unit's version (`versionSalt`). Editing `wiki.yml` re-derives the wiki, and
  changing the server's effort ceiling does too.

With the wiki off the salt is empty, so versions are feature 27's own.
`GENERATOR_VERSION` moved to `'2'` with this feature, which re-derives every
live codebase page once. That was a deliberate call (#72), recorded under
**Operations** in the changelog.

## `.knowledge/wiki.yml`

Read from the archive at the repository root, independent of `subdir`, by
`adapters/wiki-steering.ts`. The file is anyone-with-push-access input, so it
is treated like any other untrusted bytes:

- **capped before parsing** (64 KB) — an alias bomb or a pasted log is refused
  by size, not by a parser running out of memory;
- **parsed under `JSON_SCHEMA`** with an alias cap — no `!!js/*` tags;
- **validated by zod**, field by field, with caps on glob count and length,
  flow count and string sizes;
- **never fatal** — a file that fails any step is reported on the run
  (`connector.warning.wiki.configInvalid`, naming the zod path) and the code
  defaults apply. A typo must not stop the pages a repository already had.

```yaml
version: 1
effort: medium            # low | medium | high
include: ["apps/**", "packages/**"]
exclude: ["**/*.spec.ts", "**/generated/**"]
sections: [overview, architecture, modules, data-flow, api]
modules:
  max: 24                 # wins over the connector's module limit
  titles: { "apps/api": "API server" }
flows:                    # what the Data flow page traces
  - name: Document upload
    entry: apps/api/src/documents/documents.controller.ts
    symbol: finalize
focus: "Explain the revision DAG and ingestion outbox."
```

With the wiki off, the file is **not read at all**. A repository that carries
one does not change a connector that never asked for a wiki.

### One predicate: `effectiveWikiConfig`

Precedence is code default ← repository file ← connector override, and then the
env ceiling clamps. It lives in contracts, so the adapter, the API and the UI
cannot disagree about which sections exist or how much they may spend.

- **Effort** — the connector's `wikiEffort` beats the file's `effort`. An empty
  value means "from the repository". `WIKI_MAX_EFFORT` then clamps the result,
  and the clamp is reported as `{ asked, applied, clamped }` with a run warning
  (`effortClamped`), because a silent clamp lies about the configuration.
- **Sections** — the file's list, or `overview, architecture, modules,
  data-flow`. `overview` is always kept: without it the tree has no root.
- **Diagram size** — the file may lower `WIKI_DIAGRAM_MAX_NODES`, never raise it.
- **`include` / `exclude`** — compiled with the code tools' glob translator
  (`common/glob.ts`, lifted out of feature 31 so the adapters need not import
  the code-research service). They are applied inside `buildRepoMap` on top of
  `subdir`, so they only narrow. The manifest at the scope root is exempt: it
  describes the project, not a file to document.

### Effort

| effort   | what it spends                                                       |
| -------- | -------------------------------------------------------------------- |
| `low`    | nothing. Facts and tables only; `narrate()` returns before any check |
| `medium` | one narration per page: feature 27's behaviour                       |
| `high`   | medium + a bounded code-reading loop per section (phase 2)           |

No owner means no spend, exactly as feature 27. Effort `low` is checked first,
so it holds even when an owner and a model exist.

### Flows

Declared `flows` are traced as written. When the file declares none, the Data
flow page seeds one flow per entrypoint (`main.ts`, `server.ts`, …), capped at
`WIKI_DEFAULT_FLOWS`, so the page has something to show before anyone writes a
config. A declared entry that is not in the archive is skipped with
`flowEntryMissing`.

### Untrusted text

`focus` and declared flow names reach the model only inside
`wrapUntrusted(…, '.knowledge/wiki.yml', 'repo')`, appended to the user message
and never concatenated into the system prompt. A flow's `symbol` enters the
facts only once the parser has found a declaration by that name.

## Frontmatter

Wiki pages carry `generated: 'repo-wiki'`, `unit`, `headSha` and
`modulePaths`. `headSha` is the commit the archive was cut from. `git archive`
writes it as the zip comment, and `zipCommentSha` reads it from the tail, so
knowing the commit costs no request. With the wiki off, the frontmatter stays
feature 27's `generated: 'codebase-connector'`.

## Surface

| Piece                                         | Where                                               |
| --------------------------------------------- | --------------------------------------------------- |
| Vocabularies, `effectiveWikiConfig`, unit keys | `packages/contracts/src/connectors/index.ts`        |
| Steering parse, path filter                   | `apps/api/src/connectors/adapters/wiki-steering.ts` |
| Units, versions, section pages                | `apps/api/src/connectors/adapters/codebase.adapter.ts` |
| Include/exclude, module titles                | `repo-map.ts` `buildRepoMap`                        |
| Head commit                                   | `repo-archive.ts` `zipCommentSha`                   |
| Env                                           | `WIKI_MAX_EFFORT`, `WIKI_DIAGRAM_MAX_NODES`         |
| Spec                                          | `apps/api/test/repo-wiki.spec.ts`                   |
