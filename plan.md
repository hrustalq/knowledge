# Dynamic Knowledge Platform: Architecture & Execution Plan

Graph + semantic documentation platform with REST API, S3-compatible persistence,
GitLab-style versioning/diffing, and an MCP interface for AI agents.

---

## 1. Goals

- Store documentation dynamically via REST (not just Git-committed files).
- Persist raw content durably (S3-compatible object storage).
- Model both **graph relationships** and **semantic (vector) similarity** in one queryable layer.
- Support **versioning, branching, and diffing** the way GitLab does for code.
- Expose everything to AI agents through a constrained **MCP** interface (not raw DB access).
- Stay abstract and open-source-first: no dependency on Neo4j Enterprise or any single vendor.

---

## 2. High-Level Architecture

```text
REST / MCP clients
        |
        v
   Knowledge API (stateless)
        |
        +--------------------------+
        |                          |
        v                          v
PostgreSQL                     Object storage
metadata, ACLs, jobs           S3 / MinIO
tenants, revisions             raw files, attachments, revisions
        |
        v
Graph + semantic store
ArcadeDB (or Neo4j / FalkorDB / Memgraph)
nodes, edges, chunks, vectors, provenance
```

Three-store separation of concerns:

| Data                                                                   | Primary store                  | Reason                                                        |
| ---------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| Original files (Markdown, PDFs, HTML, images, attachments)             | S3 / MinIO                     | Cheap, durable, versioned object persistence                  |
| Object versions / immutable raw artifacts                              | S3 bucket versioning           | Every overwrite gets a recoverable version                    |
| Tenants, users, ACLs, document metadata, upload sessions, job state    | PostgreSQL                     | Transactional integrity, familiar relational tooling          |
| Document chunks, entities, relations, embeddings, topology, provenance | Graph/vector store (ArcadeDB)  | Native multi-hop traversal + semantic similarity in one query |
| Queue / short-lived ingestion state                                    | Redis + BullMQ (or equivalent) | Retries, back-pressure, delayed re-indexing                   |

Do **not** duplicate full document bodies as canonical data inside the graph store — it holds
source references, normalized chunks, and derived facts. S3 remains the source of truth for bytes;
PostgreSQL is the source of truth for business/revision state.

---

## 3. Technology Stack

| Layer                                            | Recommended choice                         | Alternatives                                             | Why                                                           |
| ------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------- |
| Object storage                                   | MinIO (self-hosted, S3 API)                | AWS S3, Cloudflare R2, Backblaze B2                      | Open-source, S3-compatible, versioning support                |
| Application DB                                   | PostgreSQL                                 | —                                                        | Transactional state, ACLs, revision graph metadata            |
| Graph + vector store                             | ArcadeDB (Apache 2.0)                      | Neo4j Community (GPLv3), FalkorDB (SSPL), Memgraph (BSL) | One open-source engine for graph, document, and vector models |
| Full-text/search enrichment (optional, at scale) | OpenSearch                                 | Elasticsearch, Typesense                                 | BM25/full-text + filters/aggregations beyond vector search    |
| Queue / workers                                  | Redis + BullMQ                             | RabbitMQ, SQS                                            | Async parse/chunk/embed/extract pipeline                      |
| API layer                                        | REST (NestJS/Hono-style stateless service) | —                                                        | Presigned uploads, revision endpoints, search/graph endpoints |
| Agent interface                                  | MCP server (TypeScript SDK)                | —                                                        | Task-level tools, not raw Cypher/SQL access                   |
| Embeddings                                       | Any embedding provider (local or hosted)   | —                                                        | Chunk + optionally entity embeddings                          |

### Alternative graph engines compared

| Option                | License / model                        | Best when                                     | Trade-off                             |
| --------------------- | -------------------------------------- | --------------------------------------------- | ------------------------------------- |
| ArcadeDB              | Apache 2.0; graph + document + vectors | Want a genuinely open-source all-in-one store | Smaller ecosystem than Neo4j          |
| Neo4j Community       | GPLv3; graph + vector index            | Prioritize Cypher familiarity and tooling     | GPL/Community edition constraints     |
| FalkorDB              | SSPLv1; graph + HNSW vectors           | Want Redis-like operational simplicity        | Source-available, not OSI open source |
| Memgraph              | BSL; graph + vector/text index         | Need fast real-time graph workloads           | Source-available, not OSI open source |
| Weaviate + graph DB   | Open-source vector database            | Vector retrieval dominates the workload       | Needs a second system for traversal   |
| OpenSearch + graph DB | Open-source search/vector engine       | Need rich keyword search at scale             | Graph traversal remains external      |

---

## 4. Content & Revision Model

Treat every piece of incoming material as a **versioned document**, regardless of type, and model
revisions as an **immutable revision DAG** (parents, branches, merges) — GitLab-style, not
overwrite-in-place.

```text
Document: "Authentication Architecture"

main:
  r1 ──> r2 ──> r3 ──> r5
                   \       ^
feature/oauth:      r4 ────┘
```

- `r4` is a branch revision based on `r3`.
- `r5` is a merge revision with parents `r3` and `r4`.
- Every revision is immutable once finalized; editing always creates a new revision.

Separate four layers explicitly:

| Layer                | Purpose                                           | Identifier                 |
| -------------------- | ------------------------------------------------- | -------------------------- |
| Object version       | Recover raw uploaded bytes                        | S3 `versionId`             |
| Document revision    | Business-level immutable content version          | `revisionId`, content hash |
| Revision graph       | Parentage, branches, merge ancestry               | `parentRevisionIds`        |
| Knowledge projection | Graph/vector extraction generated from a revision | `projectionId`             |

### PostgreSQL schema (revisions, branches, diffs)

```sql
create table documents (
  id uuid primary key,
  workspace_id uuid not null,
  title text not null,
  default_branch text not null default 'main',
  created_at timestamptz not null default now()
);

create table document_branches (
  id uuid primary key,
  document_id uuid not null references documents(id),
  name text not null,
  head_revision_id uuid,
  protected boolean not null default false,
  created_at timestamptz not null default now(),
  unique (document_id, name)
);

create table document_revisions (
  id uuid primary key,
  document_id uuid not null references documents(id),
  branch_id uuid references document_branches(id),

  revision_number bigint not null,
  content_hash char(64) not null,
  content_type text not null,

  s3_bucket text not null,
  s3_key text not null,
  s3_version_id text not null,

  author_id uuid not null,
  message text,
  status text not null default 'draft',

  created_at timestamptz not null default now(),
  finalized_at timestamptz,

  unique (document_id, revision_number),
  unique (document_id, content_hash)
);

create table revision_parents (
  revision_id uuid not null references document_revisions(id),
  parent_revision_id uuid not null references document_revisions(id),
  parent_order smallint not null default 1,
  primary key (revision_id, parent_revision_id)
);

create table revision_diffs (
  id uuid primary key,
  from_revision_id uuid not null references document_revisions(id),
  to_revision_id uuid not null references document_revisions(id),

  format text not null,
  additions integer not null default 0,
  deletions integer not null default 0,
  changes jsonb not null,
  created_at timestamptz not null default now(),

  unique (from_revision_id, to_revision_id, format)
);

create table ingestion_jobs (
  id uuid primary key,
  workspace_id uuid not null,
  revision_id uuid not null,
  type text not null,
  status text not null default 'queued',
  attempts int not null default 0,
  payload jsonb not null,
  error jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
```

Use `content_hash` (SHA-256) for idempotency: if normalized submitted content matches an existing
revision, return that revision instead of duplicating it.

### S3 object layout

```text
knowledge/
  workspaces/{workspaceId}/
    documents/{documentId}/
      revisions/{revisionId}/
        source.md
        normalized.json
        extracted.txt
        manifest.json
        graph-projection.json
        diff-from-parent.json
```

Enable bucket versioning in addition to revision-specific keys — this protects against accidental
overwrites/deletes, while the revision-specific path keeps the application model simple (S3 version
history is a safety net, not the revision-control system itself).

`manifest.json` is the audit anchor for each revision:

```json
{
  "documentId": "doc_01",
  "revisionId": "r5",
  "parents": ["r3", "r4"],
  "branch": "main",
  "authorId": "user_01",
  "contentHash": "sha256:...",
  "s3VersionId": "3Lg...",
  "createdAt": "2026-09-01T12:00:00Z",
  "embeddingModel": "text-embedding-3-large",
  "projectionStatus": "indexed"
}
```

---

## 5. Write Path (Ingestion Pipeline)

```text
Client
  -> REST API
  -> PostgreSQL: document + revision = PENDING
  -> Presigned S3/MinIO upload URL
  -> Client uploads object directly to S3
  -> finalize REST endpoint
  -> Queue ingestion job (BullMQ)
  -> parse / normalize / chunk / embed / extract entities & relations
  -> Upsert nodes, edges, chunks, vectors into graph store
  -> Compute diff & semantic diff vs. parent revision
  -> Mark revision INDEXED
```

Use client-side direct uploads via presigned URLs so the API never streams large file bytes itself.
Use an **outbox pattern** (or reliable enqueue-after-commit) so a successful DB write can't silently
fail to enqueue its ingestion job.

Classify extracted facts by confidence/source:

- **Explicit** — REST-provided relations, frontmatter, OpenAPI/Prisma schemas, structured metadata → authoritative edges.
- **Deterministic** — parser/AST-derived facts: links, references, named entities, IDs, citations.
- **Inferred (semantic)** — LLM-extracted relations; always carry confidence + source snippet, shown as "inferred" in UI.
- **Curated** — user-confirmed/edited edges; never silently overwritten by automated re-extraction.

---

## 6. Graph & Semantic Model

Generic, strongly typed property graph (abstract — not tied to any one project's domain):

```text
Workspace
Document
DocumentRevision
Chunk
Entity
Relation
Tag
Source
Fact
```

Core relationships:

```text
(Workspace)-[:OWNS]->(Document)
(Document)-[:HAS_REVISION]->(DocumentRevision)
(DocumentRevision)-[:HAS_CHUNK]->(Chunk)
(Chunk)-[:MENTIONS]->(Entity)

(Entity)-[:DEPENDS_ON]->(Entity)
(Entity)-[:IMPLEMENTS]->(Entity)
(Entity)-[:RELATED_TO]->(Entity)
(Entity)-[:OWNED_BY]->(Entity)

(Document)-[:DESCRIBES]->(Entity)
(Document)-[:CONTRADICTS]->(Document)
(Document)-[:SUPERSEDES]->(Document)
```

Every generated relationship carries provenance so it is inspectable and revisable:

```json
{
  "relationId": "rel_01",
  "type": "DEPENDS_ON",
  "from": "service:billing",
  "to": "service:identity",
  "provenance": {
    "revisionId": "rev_01",
    "chunkId": "chunk_18",
    "extractor": "llm",
    "confidence": 0.86,
    "createdAt": "2026-09-01T12:00:00Z"
  }
}
```

### Attaching facts to revisions (no full graph cloning)

Avoid cloning the entire graph per revision. Instead, attach facts to the revision that asserted
them and materialize "current state" only where needed:

```cypher
(:DocumentRevision {id: "r5"})
  -[:ASSERTS {
    confidence: 0.93,
    extraction: "llm",
    sourceChunkId: "chunk_7"
  }]->
(:Fact {
  subject: "OAuthFlow",
  predicate: "REQUIRES",
  object: "RefreshToken"
})
```

This enables historical queries such as:

- "What did the knowledge base state about OAuth before revision r5?"
- "When was the dependency between X and Y introduced?"
- "Which approved facts were removed by this merge?"

### Hybrid semantic + graph query pattern

```cypher
CALL db.index.vector.queryNodes('chunk_embeddings', 12, $embedding)
YIELD node AS chunk, score

MATCH (chunk)<-[:HAS_CHUNK]-(revision:DocumentRevision)
MATCH (document:Document)-[:HAS_REVISION]->(revision)
OPTIONAL MATCH (chunk)-[:MENTIONS]->(entity:Entity)
OPTIONAL MATCH (entity)-[:DEPENDS_ON|IMPLEMENTS|RELATED_TO*1..2]->(related:Entity)

WHERE document.workspaceId = $workspaceId
RETURN
  document.id, document.title, chunk.text, score,
  collect(DISTINCT entity.name) AS entities,
  collect(DISTINCT related.name) AS relatedEntities
ORDER BY score DESC
LIMIT 20
```

Security note: never rely only on a `workspaceId` property filter inside the graph query. Resolve
authorization in PostgreSQL first, then inject an immutable tenant/workspace predicate server-side
into every graph query.

---

## 7. REST API Surface

```http
# Documents & revisions
POST   /v1/documents
POST   /v1/documents/:id/revisions
POST   /v1/documents/:id/uploads
POST   /v1/documents/:id/revisions/:revisionId/finalize
PATCH  /v1/documents/:id
GET    /v1/documents/:id
GET    /v1/documents/:id/revisions
DELETE /v1/documents/:id

# Relations & entities
POST   /v1/entities
POST   /v1/entities/:id/relations
POST   /v1/documents/:id/relations
DELETE /v1/relations/:id

# Branching, comparison, merge
POST   /v1/documents/:id/branches
GET    /v1/documents/:id/compare?from=r3&to=r5&mode=direct|merge-base
POST   /v1/documents/:id/merge-requests
GET    /v1/merge-requests/:id/diff
POST   /v1/merge-requests/:id/approve
POST   /v1/merge-requests/:id/merge

# Search & graph
POST   /v1/search
POST   /v1/graph/query
GET    /v1/entities/:id/neighbors
POST   /v1/entities/:id/impact-analysis

# Ingestion
POST   /v1/ingestion/jobs
GET    /v1/ingestion/jobs/:id
```

### Example: create document (inline content)

```json
POST /v1/documents
{
  "workspaceId": "ws_demo",
  "title": "Authentication Architecture",
  "type": "architecture",
  "content": {
    "mode": "inline",
    "format": "markdown",
    "text": "# Authentication\n..."
  },
  "metadata": { "tags": ["security", "identity"], "source": "manual" },
  "relations": [
    { "type": "DESCRIBES", "target": { "type": "service", "key": "identity-service" } }
  ]
}
```

### Example: presigned upload flow response

```json
{
  "documentId": "doc_01J...",
  "revisionId": "rev_01J...",
  "upload": {
    "method": "PUT",
    "url": "https://s3.example.com/...",
    "objectKey": "workspaces/ws_01/documents/doc_01J/revisions/rev_01J/source.md"
  }
}
```

### Example: search (hybrid mode)

```json
POST /v1/search
{
  "workspaceId": "ws_demo",
  "query": "What components depend on the identity service?",
  "mode": "hybrid",
  "expandGraph": { "depth": 2, "relationTypes": ["DEPENDS_ON", "IMPLEMENTS", "DESCRIBES"] },
  "limit": 20
}
```

Response includes both an answer-ready context bundle and evidence:

```json
{
  "results": [
    {
      "entity": {
        "id": "service:identity",
        "type": "service",
        "name": "Identity Service"
      },
      "relationship": "DEPENDS_ON",
      "related": [{ "id": "service:billing", "name": "Billing" }],
      "evidence": [
        {
          "documentId": "doc_123",
          "revisionId": "rev_5",
          "chunkId": "chunk_17",
          "snippet": "Billing validates access tokens through Identity Service.",
          "confidence": 0.93
        }
      ]
    }
  ]
}
```

### Optimistic concurrency

```http
POST /v1/documents/doc_01/revisions
If-Match: "r3"
```

If the target branch has advanced past `r3`, return `409 Conflict` with a comparison link instead
of silently overwriting another author's work.

---

## 8. Diffing & Comparison (GitLab-style)

Support both comparison modes GitLab offers:

- **Direct comparison** — compare two explicit revisions (`git diff from to`); includes changes from both sides.
- **Merge-base comparison** — find nearest common ancestor, diff against it (`git diff from...to`); isolates the incoming branch's changes.

```http
GET /v1/documents/:documentId/compare?from=r3&to=r5&mode=merge-base
GET /v1/documents/:documentId/compare?from=r3&to=r5&mode=direct
```

```json
{
  "documentId": "doc_01",
  "from": { "revisionId": "r3", "branch": "main", "contentHash": "c2a3..." },
  "to": { "revisionId": "r5", "branch": "main", "contentHash": "987f..." },
  "comparisonMode": "merge-base",
  "mergeBaseRevisionId": "r3",
  "summary": { "filesChanged": 1, "additions": 18, "deletions": 7 },
  "files": [
    {
      "path": "content.md",
      "status": "modified",
      "additions": 18,
      "deletions": 7,
      "hunks": [
        {
          "oldStart": 42,
          "oldLines": 4,
          "newStart": 42,
          "newLines": 15,
          "lines": [
            { "kind": "context", "old": 42, "new": 42, "text": "## OAuth" },
            {
              "kind": "deleted",
              "old": 43,
              "text": "Tokens expire after 24h."
            },
            {
              "kind": "added",
              "new": 43,
              "text": "Access tokens expire after 15 minutes."
            }
          ]
        }
      ]
    }
  ]
}
```

Diff granularity by content type:

- **Markdown** — line-level unified/split diff, plus a semantic section diff based on heading hierarchy.
- **JSON/YAML/structured metadata** — path-level structural diff, not raw line diff.

### Semantic diff

A text diff shows _what_ changed; a semantic diff explains _what it means_ by comparing graph
projections between parent and child revisions:

```json
{
  "semanticDiff": {
    "entities": {
      "added": ["RefreshToken"],
      "removed": [],
      "changed": [
        {
          "entity": "AccessToken",
          "property": "ttl",
          "before": "24h",
          "after": "15m"
        }
      ]
    },
    "relations": {
      "added": [
        {
          "from": "OAuthFlow",
          "type": "REQUIRES",
          "to": "RefreshToken",
          "confidence": 1
        }
      ],
      "removed": []
    },
    "embeddingShift": { "score": 0.31, "meaningful": true }
  }
}
```

Only auto-generate semantic-diff facts from deterministic sources or approved inference; show
LLM-extracted relations with confidence + source excerpts, visually marked as "inferred."

### Merge requests

```http
POST /v1/documents/:id/merge-requests
GET  /v1/merge-requests/:id/diff
POST /v1/merge-requests/:id/approve
POST /v1/merge-requests/:id/merge
```

A merge request bundles: source/target branch heads, merge-base revision, unified + structural
diff, semantic graph diff, reviewer approvals/comments anchored to a line/section/entity relation,
and post-merge reindex status.

### UI: three views per merge request

- **Changes** — unified or split text diff with inline comments.
- **Structure** — metadata, tags, sections, attachments, linked entities added/removed/modified.
- **Knowledge impact** — graph nodes/relationships changed, confidence deltas, affected documents, downstream impact paths.

---

## 9. MCP Interface

Expose task-level tools to agents — never unconstrained Cypher/SQL by default.

```ts
// Search & retrieval
knowledge.search({ workspaceId, query, mode: "hybrid", kinds?, limit? })
knowledge.get_document({ documentId, revision? })
knowledge.get_entity_context({ workspaceId, entity, depth? })

// Graph reasoning
knowledge.find_relations({ workspaceId, entity, relationship?, depth? })
knowledge.impact_analysis({ workspaceId, entityId, direction?, maxDepth? })
knowledge.trace_relation({ workspaceId, fromEntityId, toEntityId })
knowledge.explain_relation({ workspaceId, relationId })

// Versioning
knowledge.list_revisions({ documentId, branch? })
knowledge.compare_revisions({ documentId, fromRevisionId, toRevisionId, mode, includeSemanticDiff? })
knowledge.create_branch({ documentId, name, fromRevisionId? })
knowledge.create_revision({ documentId, branch, baseRevisionId, content, message })
knowledge.merge_revision({ mergeRequestId, strategy: "merge-commit" | "squash" })
knowledge.get_historical_context({ workspaceId, entityId, atRevisionId })

// Curation & ingestion
knowledge.create_relation({ workspaceId, from, type, to })
knowledge.ingest({ workspaceId, documentId })

// Trusted-operator only, read-only, depth/row limited, logged
knowledge.query_graph({ cypher: string, readOnly: true })
```

Every tool result should return an evidence bundle, not just an answer:

```json
{
  "answer": "Task Engine depends on Redis for execution queues.",
  "evidence": [
    {
      "documentId": "doc_task_engine",
      "revisionId": "rev_01J",
      "chunkId": "chunk_07",
      "s3Key": "workspaces/ws_01/documents/doc_task_engine/revisions/rev_01J/source.md",
      "lineStart": 42,
      "lineEnd": 57,
      "relation": "DEPENDS_ON",
      "confidence": 1
    }
  ]
}
```

---

## 10. Local / Self-Hosted Deployment

```yaml
services:
  api:
    image: your/knowledge-api
  worker:
    image: your/knowledge-worker
  postgres:
    image: postgres:17
  redis:
    image: redis:7
  arcadedb:
    image: arcadedata/arcadedb:latest
  minio:
    image: minio/minio
```

Minimal self-hosted open-source stack:

```text
MinIO                 -> S3-compatible object storage
PostgreSQL             -> business state, ACLs, revision metadata
ArcadeDB                -> graph + vector + document store
Redis + BullMQ          -> async ingestion queue
REST API                -> stateless knowledge API
MCP server              -> agent-facing tool interface
Embedding provider       -> local or hosted
```

---

## 11. Execution Plan (Phased)

### Phase 0 — Foundations (infra bootstrap)

- Stand up Docker Compose with PostgreSQL, MinIO, Redis, and the chosen graph/vector store (ArcadeDB by default).
- Define Prisma-style (or equivalent) schema for `documents`, `document_branches`, `document_revisions`, `revision_parents`, `revision_diffs`, `ingestion_jobs`.
- Stand up bucket layout and versioning policy in MinIO.

### Phase 1 — Searchable documents (MVP)

- REST endpoints: `POST /v1/documents`, presigned upload + finalize flow, `GET /v1/documents/:id`.
- Ingestion worker: parse → normalize → chunk → embed → store chunks + vectors in the graph/vector store.
- MCP tools: `knowledge.search`, `knowledge.get_document`.
- Every answer returns precise document/chunk references (no unsourced answers).

### Phase 2 — Deterministic graph & revisions

- Add `document_branches`, `revision_parents`, revision DAG logic (immutable revisions, branch heads).
- Parse frontmatter/structured metadata (OpenAPI, schemas, explicit `relations` payloads) into deterministic graph edges with provenance.
- Implement `GET /v1/documents/:id/compare` (direct + merge-base modes) with line-level text diff.
- MCP tools: `knowledge.list_revisions`, `knowledge.compare_revisions`, `knowledge.create_branch`, `knowledge.create_revision`.

### Phase 3 — Merge workflow & structural/semantic diff

- Add merge requests: create, diff, approve, merge (merge-commit or squash).
- Structural diff for JSON/YAML/metadata (path-level, not line-level).
- Semantic diff: compare graph projections between parent/child revisions (entities/relations added, removed, changed; embedding-shift score).
- Optimistic concurrency (`If-Match` on revision writes, `409` + comparison link on conflict).

### Phase 4 — Enriched retrieval & inference

- LLM-based relation extraction from prose, tagged as "inferred" with confidence + source spans.
- Confidence-classed fact model: explicit / deterministic / inferred / curated, with curated facts protected from automatic overwrite.
- Hybrid query endpoint (`POST /v1/search`, `mode: hybrid`): vector retrieval → graph expansion → ranked, evidence-backed results.
- Impact analysis and multi-hop traversal endpoints/tools (`impact_analysis`, `trace_relation`, `find_relations`).

### Phase 5 — Governance & scale

- Workspace/tenant-scoped ACLs enforced in PostgreSQL, injected as mandatory predicates into every graph/vector query.
- Audit logging for all `knowledge.query_graph` (trusted-operator-only) calls; read-only, depth/row-limited.
- Optional OpenSearch layer for BM25/full-text at scale, alongside the vector index.
- Automated stale-document detection (topology drift vs. documentation) and reindex scheduling.
- Historical queries: "what did the KB say about X at revision r5", fact introduction timestamps, removed-facts audits.

---

## 12. Design Principles (summary)

1. **Three-store separation**: S3 for bytes, PostgreSQL for transactional/ACL state, graph store for topology + semantics.
2. **Immutable revision DAG**: never edit in place; every change is a new revision with explicit parentage.
3. **Provenance on everything**: every graph edge/fact carries source revision, chunk, extractor, and confidence.
4. **Confidence-classed facts**: explicit > deterministic > inferred > curated; curated facts are never silently overwritten.
5. **MCP as a narrow, task-level interface**: expose `search`, `get_*`, `compare_*`, `impact_analysis`, etc.; reserve raw graph queries for trusted, read-only, logged use.
6. **Diff at three levels**: raw text/line diff, structural (path-level) diff, and semantic (graph) diff.
7. **Vectors find evidence, the graph constrains and expands it** — always return source-backed citations, never bare LLM answers.
