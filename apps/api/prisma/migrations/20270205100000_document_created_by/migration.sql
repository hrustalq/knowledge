-- Who created a page (#1256): the author of its first revision, stored so the
-- document list can filter "created by me / by others" in one indexed column.
-- Nullable and no FK (house policy on user columns). Expand-only: the previous
-- image never reads it, so a rollback by retag is safe.
ALTER TABLE "documents" ADD COLUMN "created_by" UUID;

-- Backfill from the earliest revision on any branch: a page created head-less
-- behind a merge request has its first revision on that branch. A page with no
-- revision at all stays null and lists under "created by others".
UPDATE "documents" d
SET "created_by" = r."author_id"
FROM (
  SELECT DISTINCT ON ("document_id") "document_id", "author_id"
  FROM "document_revisions"
  ORDER BY "document_id", "created_at", "revision_number"
) r
WHERE r."document_id" = d."id";

CREATE INDEX "documents_workspace_id_created_by_idx" ON "documents"("workspace_id", "created_by");
CREATE INDEX "documents_workspace_id_title_idx" ON "documents"("workspace_id", "title");
