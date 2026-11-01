-- Source-backed pages (#674, phase 1). Additive only: every new column is
-- nullable or has a default, so the previous release's image runs against it
-- and a rollback by retag needs nothing undone.

-- The page a hidden per-page `web` connector belongs to.
ALTER TABLE "connectors" ADD COLUMN "owner_document_id" UUID;
CREATE INDEX "connectors_owner_document_id_idx" ON "connectors"("owner_document_id");

-- Pause, ahead count, failure and retry state of a `web` link.
ALTER TABLE "connector_links"
  ADD COLUMN "paused_at" TIMESTAMPTZ,
  ADD COLUMN "ahead_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ahead_hash" TEXT,
  ADD COLUMN "failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "gone_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retry_attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retry_at" TIMESTAMPTZ;
