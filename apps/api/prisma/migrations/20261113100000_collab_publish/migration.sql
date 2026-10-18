-- #80 phase 4: publishing a shared draft writes an ordinary revision and rebases the draft.
--
-- "Unpublished changes" compares Y snapshots (state vector + delete set), not
-- state vectors: a state vector does not move on a deletion, so a draft whose
-- only change was removing a paragraph would read as published. Phase 1's
-- column was never written, so it is renamed rather than migrated.
ALTER TABLE "collab_drafts" RENAME COLUMN "published_state_vector" TO "published_snapshot";
-- Y.encodeSnapshot of the state as last stored; null on rows stored before this.
ALTER TABLE "collab_drafts" ADD COLUMN "snapshot" BYTEA;

-- Provenance of a revision published from a shared draft. All nullable, no
-- backfill: an existing row means "not from a shared draft". No FK: a draft
-- reset keeps its id, and the revision outlives the draft either way.
ALTER TABLE "document_revisions" ADD COLUMN "collab_draft_id" UUID;
ALTER TABLE "document_revisions" ADD COLUMN "collab_snapshot" BYTEA;
ALTER TABLE "document_revisions" ADD COLUMN "co_author_ids" JSONB;
