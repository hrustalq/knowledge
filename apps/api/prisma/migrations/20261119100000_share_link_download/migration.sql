-- Share-link download (#161): an anonymous reader exports the link's scope.
--
-- 1. share_links gains `allow_download` (default false: every existing link
--    stays as it was, and a new one starts off).
-- 2. export_jobs gains `share_link_id`, the link a reader's job belongs to.
--    Nullable, no FK (house policy on actor-style columns); `requested_by`
--    keeps the link's creator for attribution.
--
-- Additive and reversible under expand/contract: the previous release ignores
-- both columns, so after a rollback a reader's jobs show up in the link
-- creator's exports until the export sweeper expires them.

-- AlterTable
ALTER TABLE "share_links" ADD COLUMN     "allow_download" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "export_jobs" ADD COLUMN     "share_link_id" UUID;

-- CreateIndex
CREATE INDEX "export_jobs_share_link_id_idx" ON "export_jobs"("share_link_id");
