-- Site search over each version's snapshot (docs/features/44, issue #77 phase 2b-2).
-- Expand-only: three nullable or defaulted columns, so the previous release runs
-- against it unchanged and a rollback needs no down migration.
--
-- No backfill here: the text lives in object storage, not in Postgres. Rows
-- written before this migration keep a null vector, and the worker fills them
-- from their pinned revisions at boot (SiteSearchTextService.backfill) — it
-- never rebuilds a version, so a frozen version stays frozen.

-- AlterTable
ALTER TABLE "site_version_pages" ADD COLUMN     "search_body" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "search_headings" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "search_vector" tsvector;
