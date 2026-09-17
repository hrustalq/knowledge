# Architecture documentation

How the platform is **actually built**, one document per logic layer.

These sit between the two documents that already existed and kept getting
conflated:

- **[`plan.md`](../../plan.md)** is design intent — the architecture as decided,
  the API surface as designed, the phased execution plan. It stays authoritative
  for _what we set out to build_.
- **[`docs/features/`](../README.md)** is the product layer — one document per
  user-visible feature, 01–27.
- **This directory** is the implementation record for cross-cutting machinery that
  belongs to no single feature: the revision DAG, the guards, the error envelope,
  the event bus, the SSR shell.

Where the code has diverged from `plan.md`, these documents say so explicitly.
`plan.md` is not retro-edited to match the code; a divergence is a fact about the
system, and hiding it makes the design document quietly untrustworthy.

Code-level conventions and gotchas live in [`CLAUDE.md`](../../CLAUDE.md), not
here. If a rule fits on one line and applies everywhere, it belongs there.

| #   | Layer                                                        | Covers                                                                      |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 01  | [Entrypoints & module boundaries](01-entrypoints-modules.md) | The four entrypoints, the Core/Queue/API/Worker split, buildless packages   |
| 02  | [Persistence & revisions](02-persistence-revisions.md)       | Branches, the immutable revision DAG, compare and diff caching              |
| 03  | [Ingestion](03-ingestion.md)                                 | The write path, embeddings providers, deterministic relations, stale sweeps |
| 04  | [Search & graph](04-search-graph.md)                         | Hybrid search, BM25 fusion, inference, entity traversal                     |
| 05  | [Merge & review](05-merge-review.md)                         | Merge requests, gates, threads, reviewers, saved filters                    |
| 06  | [Auth & ACLs](06-auth-acl.md)                                | `AUTH_MODE`, the two guards, sessions, workspace roles, audited graph query |
| 07  | [Generated client & error contract](07-api-client-errors.md) | `make api-client`, `ApiErrorPayload`, the typed web client                  |
| 08  | [Events & live updates](08-events-live.md)                   | Redis pub/sub, SSE, the WS gateway, optimistic cache updates                |
| 09  | [Web frontend](09-web-frontend.md)                           | The SSR shell, per-request isolation, cookies, hydration hazards            |
