-- AlterTable
ALTER TABLE "activity_log" ADD COLUMN     "project_id" UUID;

-- AlterTable
ALTER TABLE "document_comments" ADD COLUMN     "agent_key" TEXT,
ADD COLUMN     "pending" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "merge_request_comments" ADD COLUMN     "agent_key" TEXT,
ADD COLUMN     "pending" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "avatar_color" TEXT,
ADD COLUMN     "avatar_emoji" TEXT,
ADD COLUMN     "avatar_key" TEXT,
ADD COLUMN     "avatar_updated_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatar_key" TEXT,
ADD COLUMN     "avatar_updated_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "activity_log_project_id_created_at_idx" ON "activity_log"("project_id", "created_at");

-- Backfill activity_log.project_id.
--
-- A project feed that starts empty on the day the column shipped is not a feed,
-- so history is attributed rather than left null. Two sources, in the order the
-- writer would have used them:
--
--   1. Rows about a page take the project that page belongs to now. A page that
--      has since moved projects reads as having always lived where it lives —
--      wrong in principle, but activity_log stores no project at the time of
--      writing and inventing one is worse than following the page.
--   2. Rows about a project itself (project.created / .updated / .deleted) carry
--      it in subject_id.
--
-- Rows matching neither are workspace-level and correctly stay null.
UPDATE "activity_log" a
SET "project_id" = d."project_id"
FROM "documents" d
WHERE a."document_id" = d."id"
  AND a."project_id" IS NULL;

UPDATE "activity_log" a
SET "project_id" = p."id"
FROM "projects" p
WHERE a."subject_id" = p."id"
  AND a."document_id" IS NULL
  AND a."project_id" IS NULL
  AND a."action" LIKE 'project.%';
