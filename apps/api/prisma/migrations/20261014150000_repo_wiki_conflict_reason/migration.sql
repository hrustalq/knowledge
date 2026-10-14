-- Repo wiki (docs/features/46): why a connector_conflicts row exists.
-- 'conflict' = both sides changed (every existing row); 'regenerated' = a wiki
-- page delivered by merge request. A constant default, so no backfill: Postgres
-- fills existing rows from the default without rewriting the table.
ALTER TABLE "connector_conflicts" ADD COLUMN "reason" TEXT NOT NULL DEFAULT 'conflict';

-- The supersede lookup: the open regenerated merge requests for one page.
CREATE INDEX "connector_conflicts_document_id_reason_idx" ON "connector_conflicts"("document_id", "reason");
