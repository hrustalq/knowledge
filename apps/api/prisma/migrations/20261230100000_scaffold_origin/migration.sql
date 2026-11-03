-- #716: project scaffolding. All three columns are nullable with no default,
-- so the previous image keeps inserting rows unchanged (expand/contract) and
-- no backfill is needed: every existing revision has no origin, every
-- existing page is no collection.
ALTER TABLE "document_revisions" ADD COLUMN "origin" TEXT;
ALTER TABLE "documents" ADD COLUMN "child_template_ref" TEXT,
ADD COLUMN "child_title_pattern" TEXT;
