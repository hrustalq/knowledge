-- BM25 repair (#173): when a write to the optional fulltext index failed for a
-- revision. Nullable with no backfill — null reads as "in step", which is what
-- every existing revision was assumed to be before this column. Reversible under
-- expand/contract: the previous release neither reads nor writes it.
ALTER TABLE "document_revisions" ADD COLUMN "fulltext_stale_at" TIMESTAMPTZ;

CREATE INDEX "document_revisions_fulltext_stale_at_idx" ON "document_revisions"("fulltext_stale_at");
