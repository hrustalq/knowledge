-- Site search facets (#205): the reader filters by category and tag inside a
-- version's snapshot. Category is copied from each page as it stands today,
-- the best a snapshot built before this column can know; a rebuild records
-- the category at build time. Tags stay null here and are read from each
-- row's pinned revision by SiteSearchTextService on the next boot.
-- Reversible under expand/contract: the previous release neither reads nor
-- writes either column.
ALTER TABLE "site_version_pages"
  ADD COLUMN "category" TEXT NOT NULL DEFAULT 'other',
  ADD COLUMN "tags" JSONB;

UPDATE "site_version_pages" p
SET "category" = d."category"
FROM "documents" d
WHERE d."id" = p."document_id";
