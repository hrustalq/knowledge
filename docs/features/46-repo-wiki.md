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

| `externalId`           | page                                                            | version hashes                                         |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| `overview` (kept)      | the hub: a section index, then modules, languages, entrypoints  | manifests + README + module list + sections + steering |
| `wiki:architecture`    | components, how the modules depend on each other                | manifests + module names/entrypoints + steering        |
| `wiki:data-flow`       | one entry per flow: its entry file, signatures, what it imports | each flow's entry file + the flow list + steering      |
| `wiki:api`             | exported symbols by module                                      | exported signatures only + steering                    |
| `module:<path>` (kept) | one per module, unchanged                                       | the module's files + steering                          |

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
effort: medium # low | medium | high
include: ["apps/**", "packages/**"]
exclude: ["**/*.spec.ts", "**/generated/**"]
sections: [overview, architecture, modules, data-flow, api]
modules:
  max: 24 # wins over the connector's module limit
  titles: { "apps/api": "API server" }
flows: # what the Data flow page traces
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

| effort   | what it spends                                                                        |
| -------- | ------------------------------------------------------------------------------------- |
| `low`    | nothing. Facts and tables only; `narrate()` returns before any check                  |
| `medium` | one narration per page: feature 27's behaviour                                        |
| `high`   | medium + a code-reading loop per section, capped by `WIKI_HIGH_EFFORT_MAX_TOOL_CALLS` |

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

## Diagrams

Pages store Mermaid source; the web renders it (`MarkdownView.vue`, `securityLevel:
'strict'` + DOMPurify). **Only `wiki-diagrams.ts` writes Mermaid**, and nothing
from the repository or a model is ever spliced in as syntax:

- every label goes through `mermaidText`, which is a **whitelist**: letters,
  digits and a short punctuation list survive, and everything else becomes a
  space. `%%`, `click`, `#35;`, quotes, backticks and HTML are each a character
  a blacklist would have had to know about. Labels are capped at 60 characters;
- node ids are ours (`m0`, `x1`, `C2`, `P3`);
- supertypes that are not identifier-shaped are not drawn at all;
- `lintMermaid` checks the output against the handful of line shapes the
  builders emit. A failure drops that diagram and warns `diagramInvalid`; the
  page still stages.

| Diagram           | Where                         | Built from                                                                                                                                                                   |
| ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---- |
| `flowchart LR`    | Architecture                  | modules as boxes, cross-module imports as arrows, external packages used by more than one module as dashed nodes. Modules first in the node budget, the most connected first |
| `classDiagram`    | each module page (`## Types`) | exported classes, interfaces, structs and traits with members, `extends` (`<                                                                                                 | --`) and `implements` (`< | ..`) |
| `sequenceDiagram` | Data flow, one per flow       | the model's **JSON** (`sequenceSchema`: participants and messages), rendered here. At effort `low`, there is no sequence diagram                                             |

`WIKI_DIAGRAM_MAX_NODES` caps every chart; `wiki.yml` `diagrams.maxNodes` may
lower it, and `diagrams.{architecture,class,sequence}` turn each kind off.

### Edges

`import-resolver.ts` resolves each file's imports against the module map:

- **Bare specifiers** match a manifest name, exactly or as a subpath
  (`@knowledge/contracts/core` → `packages/contracts`). This works in every
  ecosystem whose manifests carry a name.
- **Relative specifiers** are resolved as paths, but only for
  TypeScript/JavaScript, where the specifier _is_ a path. The resolver tries the
  NodeNext `./x.js` → `x.ts` spelling, an omitted extension and `/index`.
- Anything else is external. The architecture page says so when the repository
  has other languages.

Manifest-declared dependencies between modules are merged in.

The architecture version hashes `edgeDigest`: the edge **set**, without counts.
One more call between two modules that already depend on each other draws no
new arrow, so it re-derives nothing.

### Inheritance

`CodeSymbol` gained optional `extends`, `implements` and `members` (capped at
12), read per grammar:

| Language                | `extends`                                                                  | `implements`                          |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| TypeScript / JavaScript | `class_heritage` → `extends_clause`; interfaces from `extends_type_clause` | `implements_clause`                   |
| Java                    | `superclass`; interfaces from `extends_interfaces`                         | `super_interfaces`                    |
| Python                  | positional bases (`metaclass=` skipped)                                    | —                                     |
| Rust                    | trait bounds                                                               | `impl Trait for Type`, same file only |
| Go                      | embedded fields (a field with no name)                                     | —                                     |

The shapes were read off real trees, and the spec asserts them.

### Flows and sequence diagrams

A flow's horizon is its entry plus the files it reaches within two hops
(`reachableFiles`, at most 12):

- relative imports resolved to files;
- a bare import of a sibling module resolved to that module's first
  entrypoint.

The Data flow version hashes exactly those files. The sequence prompt
(`SEQUENCE_CONTRACT`, operation `wiki`) is shown their outlines, which are
facts, not source. Declared flow names reach the model only inside the
untrusted wrapper.

## Effort `high`

Each page's narration becomes a read: `runCodeReadingLoop`
(`agents/code-reading-loop.ts`, the archaeologist's loop, lifted) with the four
code tools from `code-research/code-tools.ts`, run over the archive this sync
already holds. The `connectorId` parameter is dropped from the tool
definitions, because the adapter decides which repository is read. The tool
budget is the agent's, lowered to `WIKI_HIGH_EFFORT_MAX_TOOL_CALLS`. An agent
without tool capability falls back to one plain call. Billed as `wiki`.

## Archaeologist interplay

The archaeologist (feature 31) reads the pages under the connector destination
as "declared". Two changes keep it useful once a wiki exists:

- **A generated page's file listing is not a declaration.**
  `declaredText` drops the `- [\`path\`](url)`lines from pages whose
frontmatter says`generated: repo-wiki | codebase-connector`. Otherwise every
  file a module page lists would look documented.
- **A module's entry file is covered at module granularity.**
  `wikiModulePaths` reads `modulePaths` from the wiki's pages, except the
  hub's. `isWikiCovered` skips a module's `index`/`main`/`lib`/`mod`/… file,
  since the module page describes its public surface. Logic files below it
  stay candidates.

## Regenerating on push

`codebase` now has `capabilities.webhook: true`. That reverses feature 27's
deferral, without its objection. A push names *files*, and which unit a file
feeds is not knowable until the archive has been read. So a push never names
units.

`ConnectorsService.queueRepoPush` queues an **unscoped** pull run
(`trigger: 'webhook'`). `ConnectorStagingService.stage` then skips every unit
whose input hash did not move, before anything is fetched. A push costs one
archive download and some hashing. Model calls happen only for the units whose
inputs actually changed.

- **Gated** on `wiki: on` and `wikiAutoRegenerate: on-push`. Both default off.
  A published release also counts whenever release notes are on, since that
  delivery is what writes its release page.
- **Branch filter.** Only a push to the branch the connector reads counts: the
  configured Branch, or the repository's default when Branch is empty, as named
  by the delivery (`repository.default_branch` or `project.default_branch`). A
  delivery that names neither is refused rather than guessed. A release
  (`release.published`, GitLab `Release Hook` `create`) always counts. Branch
  deletions and tag pushes start nothing.
- **Debounce.** The run is enqueued with a BullMQ one-shot `delay` of
  `WIKI_PUSH_DEBOUNCE_MS`. This is not a repeatable, so the no-cron rule
  holds. While the run waits, further pushes find it (`status: queued`,
  `startedAt: null`) and fold into it, so three pushes in the window make one
  run. A waiting *scoped* run is widened to unscoped.
- **Entry points.** The GitHub App hook (`push` and `release` beside the
  existing `publishBare`) and the per-connector hook. In the per-connector
  hook, a `codebase` delivery is verified with the same secret as a pull
  request (`verifyRepoDelivery`) and never reaches the adapter, so
  `CodebaseAdapter` has no `verifyWebhook`.
- **GitHub access.** New purpose `wiki`, needing `contents: read` and the `push`
  event. It shows on the access card while push regeneration is on.

## Delivery as merge requests

`wikiDelivery: 'merge-request'` (default `'direct'`) routes an **update** of
`overview`, `module:*`, `wiki:*` or `changelog:unreleased` through the conflict
path: a branch `wiki/<run>-<ts>`, a revision on it, and a `connector_conflicts`
row with **`reason: 'regenerated'`** (new column, default `'conflict'`). The
page itself is not touched. This applies only in `auto` mode: a review or step
run has already put a person in front of the change. A **create** still
publishes directly, because there is no page to open a merge request against.

`ConnectorConflictSweeper` (API-side, because the worker never opens a merge
request) handles regenerated rows differently:

- **Title and description** come from `connector.mr.wikiTitle` /
  `wikiDescription`, naming the commit and unit read from the revision's own
  frontmatter, so nothing is stored twice.
- **Author**: the connector owner, whose agent wrote the page. A plain conflict
  keeps the stub it always had.
- **Supersede**: a pending regeneration with a newer pending one behind it
  becomes `superseded` without a merge request. After opening one, the sweeper
  closes the older still-open regeneration merge requests for the same page,
  as the owner.

### A merged regeneration is not a local edit

After a merge, the head holds what the connector generated, while
`connector_links.contentHash` still holds what it last wrote directly.
`decideAction` would read that as a local edit and turn the next regeneration
into a conflict. So when the head differs, it also checks whether the head is
byte-for-byte the latest regenerated revision (`isOurRegeneration`).

### Fixed on the way: frontmatter pages always looked edited

`headContentHash` hashed `getContent().markdown`, the body *without* its
frontmatter, and compared it with a `contentHash` taken over the markdown as
written, frontmatter included. Every page carrying frontmatter, which means
every codebase page, therefore looked locally edited. Under the default
`manual` conflict policy, every update became a conflict merge request. The
head is now hashed over its stored bytes, the same text the connector wrote.

## Release notes

The connector's **Release notes** setting (`changelog: on`) turns them on. So
does listing `changelog` in `wiki.yml` `sections` while the wiki is on. They
add three kinds of unit under the overview:

| `externalId` | page | version hashes |
| --- | --- | --- |
| `changelog` | Releases hub: every matching tag, newest first, with those past the cap marked _not generated_ | tag names + shas + the cap + steering |
| `changelog:unreleased` | the commits since the newest tag | branch head sha + newest tag sha + steering + effort |
| `changelog:tag:<tag>` | one release: the commits since the previous tag | the tag's sha **only** |

The issue sketched `changelog:<tag>`. The key is `changelog:tag:<tag>` so that
a tag named `unreleased` cannot collide with Unreleased.

**A published release never regenerates.** Its version is its commit and
nothing else: not the steering file, not the effort, so editing `wiki.yml`
leaves every released page alone. Only a `GENERATOR_VERSION` bump re-derives
them. A first sync generates the `CHANGELOG_MAX_RELEASES` newest tags; older
ones are listed on the hub and never generated. Otherwise four hundred tags
would mean four hundred model calls.

### History (`adapters/repo-history.ts`)

GitHub and GitLab REST, through `connectorFetch` with the archive's credential.
Any other host fails with a reason, which the hub shows as a warning rather
than a failed discovery.

- **Tags**: matched against `changelog.tagPattern` (default `v*`) and sorted by
  version (`v1.10.0` after `v1.9.0`; a pre-release below its release).
- **Range**: `compare` from the previous tag to this one; the first release
  reads the head's own history. Each range is capped at
  `CHANGELOG_MAX_COMMITS_PER_RELEASE`, keeping the newest commits, and a
  truncation warns.
- **Requests**: a commit is tied to its pull or merge request by the number in
  its own message (`(#12)`, `Merge pull request #12`, `See merge request …!12`),
  never by one request per commit. Labels come from **one search per breaking
  label** (`is:pr is:merged label:"breaking"`, or GitLab's `labels=`).
- **Links**: every link is built from the host plus a sha or a number. None is
  ever taken from a message.

### Grouping and breaking changes (`adapters/changelog.ts`)

Entries fold to one per request, so a merge-commit repository's several commits
make one line. A merge commit is read by the title under its header. Groups
mirror our CHANGELOG: Breaking, Added (`feat`), Changed (`perf`, `refactor`,
`revert`), Fixed (`fix`), Removed (`remove`, `deprecate`), and Other for
everything that is not a conventional commit.

There are four ways a change is found to be breaking (`BREAKING_CHANGE_SOURCES`):

1. **`conventional-commit`**: `type(scope)!:` or a `BREAKING CHANGE:` footer.
   `parseConventionalCommit` lives in contracts, so the web and the API read
   `feat(api)!:` the same way. A footer runs until the next git trailer, in
   either the `Token: value` or `Token #value` form.
2. **`label`**: the request carries a label from `changelog.breaking.labels`
   (default `breaking`, `breaking-change`).
3. **`api-surface`**: exported symbols at the previous tag vs this one
   (`downloadRepoArchiveAtTag`, cached per run). Only modules holding a file the
   range changed are compared, each up to the module page's file cap. A removed
   export or a changed signature is breaking; an added one is listed under
   Added. Signatures are compared with whitespace normalised. When the host did
   not list every changed file, the page says the API was not compared, rather
   than comparing everything.
4. **`model`**: at effort `medium` and up, one call (operation `changelog`)
   writes the 3–5 sentence summary and up to five suspicions. A suspicion must
   cite a change by the label it was handed (`#12` or a short sha) and must not
   already be breaking. Anything else is dropped. Suspicions render under
   **Possibly breaking** and never join the confirmed list. Commit text reaches
   the model only inside the untrusted wrapper.

Repository text placed on the page is made inert: one line, with no HTML, no
links or images, and no headings.

Release pages carry `tag`, `date`, `breakingCount` and `suspectedCount` in
frontmatter. The Releases tab (phase 5) reads those counts from there.

## Frontmatter

Wiki pages carry `generated: 'repo-wiki'`, `unit`, `headSha` and
`modulePaths`. `headSha` is the commit the archive was cut from. `git archive`
writes it as the zip comment, and `zipCommentSha` reads it from the tail, so
knowing the commit costs no request. With the wiki off, the frontmatter stays
feature 27's `generated: 'codebase-connector'`.

## Surface

| Piece                                          | Where                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Vocabularies, `effectiveWikiConfig`, unit keys | `packages/contracts/src/connectors/index.ts`                                       |
| Steering parse, path filter                    | `apps/api/src/connectors/adapters/wiki-steering.ts`                                |
| Units, versions, section pages                 | `apps/api/src/connectors/adapters/codebase.adapter.ts`                             |
| Include/exclude, module titles                 | `repo-map.ts` `buildRepoMap`                                                       |
| Head commit                                    | `repo-archive.ts` `zipCommentSha`                                                  |
| Diagrams, label escaping, lint                 | `adapters/wiki-diagrams.ts`                                                        |
| Import → module edges, flow horizon            | `adapters/import-resolver.ts`                                                      |
| Inheritance and members                        | `adapters/code-symbols.ts` `typeFacts`                                             |
| Code tools over any snapshot                   | `code-research/code-tools.ts`                                                      |
| The reading loop                               | `agents/code-reading-loop.ts`                                                      |
| Archaeologist coverage                         | `agents/archaeology.ts` `declaredText`, `isWikiCovered`                            |
| Env                                            | `WIKI_MAX_EFFORT`, `WIKI_DIAGRAM_MAX_NODES`, `WIKI_HIGH_EFFORT_MAX_TOOL_CALLS`     |
| Specs                                          | `test/repo-wiki.spec.ts`, `test/wiki-diagrams.spec.ts`, `test/archaeology.spec.ts` |
