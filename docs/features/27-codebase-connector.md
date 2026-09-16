# 27 — Codebase connector

Point the platform at a GitHub or GitLab repository and get documentation about
the project: a hub page for the repository and one page per module, derived from
the source itself.

Half of this already existed. `markdown-git` (feature 19) downloads the whole
repository as a zip, unzips it in memory with `fflate`, and then discards every
file that is not `.md` — with staging, review, the `connector_links` identity
map, conflict-to-merge-request, and scheduled re-sync already wrapped around it
(features 19 and 26). The other half had nothing to build on: no AST library, no
language detection, no source chunker, and no source-code entry in
`IMPORT_FORMATS`.

So this feature is one adapter and one analysis layer under it. **There is no
migration.** `Connector.kind` is a plain `String`, `Connector.config` is
free-form `Json`, and `ConnectorRunItem` already carries `externalVersion`,
`contentHash`, `stagedKey` and `draft`. The catalogue in `packages/contracts` is
the only place a kind is enumerated, and adding one there is what makes the
settings form, the create guard and the worker registry agree by construction.

## What a repository becomes

Two kinds of unit, and the `externalId` of each is a permanent identity — it is
the `connector_links` key, which is what makes a second sync update a page
rather than duplicate it:

| `externalId`                  | page                                                            |
| ----------------------------- | --------------------------------------------------------------- |
| `overview`                    | the hub: modules, languages, entrypoints, top-level dependencies  |
| `module:<repo-relative-path>` | one per module: what it is, its public API, what it depends on    |

A **module** is a directory that holds a manifest — `package.json`, `go.mod`,
`pyproject.toml`, `Cargo.toml`, `pom.xml`, `composer.json`, `Gemfile`. A
repository that declares none (a folder of scripts) falls back to its first level
of directories, because that is the only structure such a repository actually
states. Files are assigned to the **deepest** matching root, so a monorepo's own
root `package.json` keeps the files that belong to no workspace instead of
swallowing all of them.

Modules are ordered largest-first and capped (`maxModules`, default 24): if a
limit has to bite, it should bite the least of the code, and the hub says how
many were left out.

## The version of a page is the hash of its inputs

`ExternalRef.version` for a unit is a hash of the files that feed it — each
path plus the digest of its bytes — mixed with a `GENERATOR_VERSION` constant.

This is the whole cost story. `ConnectorStagingService.stage` compares the
version against the link's stored one and returns `unchanged` **before calling
`fetch`**, so a re-sync of a repository nobody has touched performs one archive
download, hashes some bytes, and makes no model calls at all. Touch one file and
exactly one module re-derives.

It also gives us a way to improve shipped pages. A better prompt or a better
extractor changes nothing about a repository's source, so every unit would skip
forever; **bumping `GENERATOR_VERSION` is how a release re-derives pages that
are already live.**

## The adapter derives, the pipeline stages, the API applies

Every other adapter is plain `fetch` with no model anywhere near it. This one
injects the model client, and that is a deliberate exception rather than an
oversight.

The reason is that every other adapter's external system already holds prose.
This one's holds source code, so there is no "fetch the text" step to keep
separate from "write the text" — the fetch *is* the derivation. Keeping it in
the adapter is what avoids the alternative: a kind-specific branch inside
`ConnectorSyncService`, which would put this feature's shape into the generic
pipeline every other connector runs through.

The rule that replaces the one being bent is **the adapter derives, the pipeline
stages, the API applies** — feature 17's *worker generates, API publishes*, one
layer down. Nothing in the adapter writes a page. Staging, review, apply, revert
and conflict handling are untouched.

Mechanically this cost three imports in `ConnectorAdaptersModule`
(`AiCoreModule`, `AgentCoreModule`, `AssistantClientModule`), all three of them
controller-free halves that `AgentWorkerModule` already imports for exactly this
reason — so the module stays importable by the worker, which is the property its
doc comment was really protecting. What is still deliberately absent is anything
that can write.

## Two layers, and the second one is optional

**The deterministic layer is tree-sitter.** Modules, exported symbols with their
signatures, dependencies, entrypoints, file layout — facts a parser produced,
rendered as markdown tables. It costs nothing and it is the page's substance.

**The model layer writes the prose that opens the page**, from those facts. It
is routed through the existing `author` agent rather than a new built-in:
`author`'s job is already "produce a new page's prose from context", and feature
20 warns that an eleventh built-in differing only in framing is roster drift. An
operator can therefore already edit the prompt and pick the model for it.

The model is given the *facts*, not the source. The facts are smaller, and they
are also better: a signature list says what a module offers far more precisely
than twelve thousand characters of implementation would.

If there is no model configured, no owner to bill, no budget left, or the call
simply fails, **the page still stages** — carrying a warning that says which.
A connector that produced nothing when the AI was switched off would be a worse
version of a feature that already works without it.

## No owner, no spend

`connectors.created_by` is nullable, and `ai_usage.user_id` is a `uuid` column
whose insert is deliberately swallowed on failure. Billing an ownerless
connector would therefore be spend that no budget sees and no usage view
reports — precisely the invisible background spend feature 20 made
`agent_runs.created_by` NOT NULL to prevent.

That column predates this feature and cannot be tightened without a migration,
so the adapter refuses instead: **with no owner, the deterministic page is
produced and no model is called.** The reason appears on the run as a warning
rather than as silence.

The owner and the connector's frozen `locale` reach the adapter through two new
fields on `ConnectorContext`, read off the row in `ConnectorsService.contextFor`
— because the path that needs them most is the worker's, where there is no
request to read either from.

## tree-sitter, and why the WASM binding

`web-tree-sitter` with grammars from `@vscode/tree-sitter-wasm`, not the native
`tree-sitter` package. It is the same parser and the same grammars; only the
binding differs. Three things decided it:

1. `tree-sitter` declares `"install": "node-gyp-build"`, and pnpm 10 blocks
   dependency build scripts unless the package is listed in
   `pnpm-workspace.yaml`'s `onlyBuiltDependencies`. It would install *silently
   unbuilt* and fail at the first parse.
2. `Dockerfile.api`'s base stage carries `openssl` and `ca-certificates` and
   nothing else, so node-gyp would need a full C++ toolchain added to an image
   built on a 3.8 GB box that already caps the builder at 2560 MB because two
   concurrent `tsc` runs can exhaust it.
3. The WASM packages ship prebuilt with no lifecycle scripts at all, so they need
   no allowlist entry and no Dockerfile change — only that they are declared as
   `dependencies`, since the `prod-deps` stage runs `pnpm install --prod` and
   would strip a devDependency.

Both wasm paths are resolved at runtime with `import.meta.resolve` rather than
copied by `nest-cli.json`, which is what makes them work identically under
`nest start --watch` (running from `src`), from `dist`, and inside the image.
The grammars are ABI 14/15 and load into the 0.27 runtime unchanged — verified
before any of this was written, because an ABI mismatch fails at
`Language.load` and nowhere earlier.

**Nothing happens in the constructor.** `scripts/generate-openapi.main.ts` builds
the whole provider graph and never calls `.init()`, so an `onModuleInit` would
run in the worker and the MCP server but not there — meaning init timing would
differ per entrypoint. Lazy-on-first-parse is the only shape that is identical
in all four, and it keeps a schema-emitting script that touches no
infrastructure from compiling 12 MB of wasm.

Trees are freed explicitly. `Tree` holds memory in the Emscripten heap that V8
cannot collect, so `TreeSitterService.withTree` takes a callback and never
returns a tree: a tree that escapes would be a leak in a process that runs for
weeks, and a callback makes that unrepresentable rather than merely discouraged.
One `Parser` is reused with `setLanguage` per file, which is safe because the
sync pipeline is sequential by construction — `ConnectorProcessor` takes BullMQ's
default concurrency of 1 and the walk is an ordered loop, not a fan-out.

Measured on this repository: 272 files and 1.6 MB of TypeScript parse in 209 ms,
and three grammars cost about 12 MB resident. Parsing is not the cost centre;
the model calls are.

## Surface

Config fields, which drive the settings form and the setup wizard alike:

| field        | required | meaning                                            |
| ------------ | -------- | -------------------------------------------------- |
| `repoUrl`    | yes      | the repository. Inherits the SSRF guard, because `ConnectorsService.validateConfig` runs `assertSafeExternalUrl` over any field whose key ends in `url` |
| `branch`     | no       | defaults to `main`                                  |
| `subdir`     | no       | only code under this path is read                   |
| `maxModules` | no       | at most this many module pages, largest first (24)  |

The wizard reuses `markdown-git`'s two steps — repository and token, then branch
and folder — because it is the same archive being downloaded. `maxModules` rides
along with the branch step for the reason `rootPageId` rides along with the
space: it refines *how much*, and a step of its own would make everyone press
Next past a question most repositories never answer.

## Deliberately deferred

- **Webhooks.** `seedScope` turns whatever `verifyWebhook` returns directly into
  identity-map keys, but a push event names *files*, and which module a file
  belongs to is not knowable until the archive has been read. A webhook could
  only guess, and every wrong guess seeds a `connector_links` key for a page
  that does not exist. Scheduled sync covers the same ground a few minutes
  later, and costs a hash rather than a call for everything that did not change.
- **Push.** These pages exist nowhere upstream; there is no counterpart to write
  back to. `capabilities.push: false` is the type-level half of saying so.
- **Cross-module dependency edges.** Bare import specifiers are aggregated per
  module, which answers "what does this rest on". Resolving *relative* imports
  into edges between module pages needs a per-language resolver
  (`tsconfig` paths, Go module paths, Python packages) and is its own piece of
  work.
- **Graph relations between derived pages.** A `PART_OF` edge from each module to
  the hub would want `RELATION_EDGE_TYPES` widened, and nesting already carries
  the same meaning through the connector's destination parent.
- **Languages beyond the shipped grammars.** Sixteen ship with the bundle; a file
  in anything else is skipped and counted in the run's warnings, never fatal.
