# 28 — Relation management

## What this is

An agent that proposes the relations a page should declare, and a tool surface
that lets the assistant add, change and remove them — always as a merge request,
never as an edit to a live page. Plus the frontmatter write path both of those
needed, which did not exist for models *or* people.

## The gap this was written into

Relations are the load-bearing structure of the knowledge base: `DESCRIBES` is
what makes impact analysis and dependent reindexing work. But until now they
could only be *maintained* by a person hand-editing YAML in the editor's
settings sheet, and the two write paths that existed were disjoint:

| Path | Writes | Survives re-indexing | Visible in the page |
| --- | --- | --- | --- |
| `POST /:id/relations` (and `/curate`) | an ArcadeDB edge, class `explicit`/`curated` | yes, it is never re-derived | **no** |
| frontmatter `relations:` | the markdown, replayed as `frontmatter` edges at ingest | yes, re-derived every time | yes |

The first is not what "the page declares a relation" means — the edge exists in
the graph and nowhere in the source, so a reader of the markdown cannot see it
and a rebuild from source cannot reproduce it. The second was **read-only in
practice**: the ingestion worker parses frontmatter, and nothing in the revision
pipeline ever wrote it back. Repo-wide, `matter.stringify` appeared exactly once,
in `connector-markdown.ts`.

So "let the assistant manage frontmatter relations" required building the write
path first, and it is the same one a human now benefits from.

## Decisions

**A relation edit is a revision, so it is a merge request.** Declaring a
relation means changing the page, and an AI-authored page change is a proposal —
the rule `propose_update` and `AgentFindingsService.propose` already follow.
`DocumentRelationsService` walks that exact path: branch → revision →
`putObjectText` → finalize → `MergeRequestsService.create`. Unlike the findings
path there is no model call in the middle, so the whole write fits in one
transaction rather than having to keep an LLM round trip outside it.

**Only `relations:` and `tags:` are touched.** Every other frontmatter key is
carried through byte for byte. This is not politeness, it is correctness: the
editor used to rebuild the block from those two keys alone and destroyed
everything else — `source:`, written by *every* connector adapter, and
`glossary: false`, which `DocumentCanvas` reads. That bug is fixed here as a
prerequisite, in `EditorPage.buildSource` and in one shared serializer
(`common/frontmatter.ts`); without it, an AI-added relation would be erased the
next time somebody saved the page.

**The churn is accepted and declared.** `matter.stringify` re-serializes through
js-yaml, so keys and values survive but comments and quoting style do not. A
relation edit therefore shows some incidental reformatting in the merge-request
diff. The alternative — splicing text ranges — trades a cosmetic diff for a
parser that can corrupt a page. The MR description says so, so a reviewer is not
surprised by it.

**The cartographer is background-only and tool-free.** It follows the curator
exactly, for the curator's reason: which pages declare nothing, and which edges
exist only because a model guessed them, are *queries*. The worker settles those
deterministically and spends the model call on the half that is judgement.
Interactive editing belongs to the conversational agents, because writing a page
is the API's act — feature 17's rule, unchanged: the worker generates, the API
publishes.

Its sharpest finding is deterministic: an `inferred` edge the page does not
declare. A model read that connection out of the text, nobody ever confirmed it,
and it is replaced wholesale on the next re-index — a claim the graph carries
and the page does not. Declaring it is mechanical, so the finding carries the
exact relations to declare and the Apply button does the rest.

**One vocabulary, finally.** The relation type list existed in **seven** copies
that had already drifted: the SQL allowlist had eight types, the frontmatter
parser and the DTO seven, and the workflow canvas five — while
`workflow-draft.service.ts` silently rewrote anything it did not recognise to
`IMPLEMENTS`, and `produces.relationToParent` was an unvalidated `string` that
`assertEdgeType` would throw on at materialize time, after a person had already
approved the draft. `RELATION_EDGE_TYPES` and `AUTHORABLE_RELATION_TYPES` now
live in `@knowledge/contracts`, and `RelationInput.type` is narrowed to the
authorable set so a writer cannot forget the rule. `TAGGED_WITH` is excluded
from the authorable list on purpose: a tag edge is synthesised from `tags:`, and
accepting it as a relation would give tags two spellings that behave differently.

## Data model

None. There is no relation table and this adds none — relations remain graph
edges, and what changed is that the page's own frontmatter can now be written.
`AgentFinding` gained an optional `relations` payload, which is what lets a
finding be applied as a structural edit rather than handed to a model that would
rewrite the prose.

## Routes

| Route | Access | Notes |
| --- | --- | --- |
| `POST /v1/documents/:id/relations/propose` | editor | Frontmatter patch → merge request. `changed: false` when it is a no-op, rather than an empty MR |
| `POST /v1/ai/agents/runs/:id/findings/:index/apply-relations` | editor | Applies a finding's relations. Attributed to the caller, not the run's owner |

Tools: `list_relations` (viewer — declared relations, tags, and graph edges with
their class side by side) and `edit_relations` (a write tool, editor-only,
hidden entirely in Ask mode).

## Workflows

`WorkflowNodeDraft` has carried `frontmatter` and `relations` since feature 17,
the DTO validated them and the materializer wrote them — and **no executor ever
produced them**: `ai.draft` explicitly told the model "no front matter". That is
the same declared-and-ignored defect feature 20 was written against
(`WorkflowStep.tools`). Now:

- `ai.draft` returns `relations` and `tags` in its JSON contract, validated and
  **dropped** — never coerced — when a type is unknown.
- The materializer merges frontmatter instead of bailing whenever the body
  already began with `---`, which silently discarded everything the step
  produced.
- `WorkflowNodePanel` renders and edits a draft's relations and tags, so a
  reviewer no longer approves proposed graph facts sight-unseen.
- `validateGraph` rejects an unknown `produces.relationToParent` live on the
  canvas (`unknownRelationType`), where the editor can still fix it.

## Limits

- Merge-request diffs show incidental frontmatter reformatting (above).
- The cartographer reads titles, categories and existing relations — not page
  bodies. It is deliberately cheap; a body-reading pass would be one model call
  per page, which is the reviewer's cost model, not a sweep's.
- No MCP relation tools. stdio has no principal and `created_by` is NOT NULL —
  the reason `knowledge_run_agent` was refused (`20-agents-todo.md` item 3).
- No proposal/staging table. An inferred edge is already live in the graph;
  adding a pending state for one class and not the others would be a second
  answer to the same question.
- The materializer still writes frontmatter *and* passes explicit DTO relations,
  producing edges of two classes for a generated page. Pre-existing; changing it
  risks the parent edge vanishing before the first index.

This closes `20-agents-todo.md` item 5's carve-out: `orphan` findings were
refused for merge-request proposals because "the fix is a relation, not prose",
and until now could not be acted on at all.
