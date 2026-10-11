-- Issue #66 (docs/features/39 + 40): page ownership, review interval and
-- expiry, the declared verification flag, inactivity, archive, and the
-- per-workspace freshness settings. Hand-edited after `prisma migrate diff`:
-- every column is nullable or defaulted, so the previous release's image runs
-- against this schema unchanged (expand-only; rolling back the code leaves the
-- columns in place and inert).
--
-- Two backfills, both from facts the database already holds:
--   * last_activity_at — the newest of the page's creation, its last finalized
--     revision and its last freshness action in activity_log (the same set
--     FRESHNESS_ACTIONS names in @knowledge/contracts), so "inactive" means
--     the same thing for a page that predates the column as for one that does
--     not. The DEFAULT covers rows an older image inserts during a rollback.
--   * owner_id — the author of the page's first revision, when that author is
--     a real account (not the zeros dev stub) and still a member of the page's
--     workspace. Anything else stays NULL and reads as unowned, which is
--     exactly what the knowledge-health dashboard exists to show.
--
-- document_revisions.body_chars is NOT backfilled: content lives in MinIO, not
-- here. NULL reads as "unknown", never as "empty"; the verification sweeper
-- fills it in bounded batches.

-- AlterTable
ALTER TABLE "document_revisions" ADD COLUMN     "body_chars" INTEGER;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "archived_at" TIMESTAMPTZ,
ADD COLUMN     "archived_by" UUID,
ADD COLUMN     "expired_notified_at" TIMESTAMPTZ,
ADD COLUMN     "expiry_reminded_at" TIMESTAMPTZ,
ADD COLUMN     "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "owner_id" UUID,
ADD COLUMN     "review_interval_days" INTEGER,
ADD COLUMN     "verification_expires_at" TIMESTAMPTZ,
ADD COLUMN     "verification_flag" TEXT,
ADD COLUMN     "verification_note" TEXT,
ADD COLUMN     "verification_source" JSONB;

-- Backfill last_activity_at (see header).
UPDATE "documents" d
SET "last_activity_at" = GREATEST(
    d."created_at",
    COALESCE((SELECT MAX(r."finalized_at") FROM "document_revisions" r WHERE r."document_id" = d."id"), d."created_at"),
    COALESCE((
        SELECT MAX(a."created_at") FROM "activity_log" a
         WHERE a."document_id" = d."id"
           AND a."action" IN ('revision.finalized', 'merge-request.merged', 'document.comment.created', 'document.verified')
    ), d."created_at")
);

-- Backfill owner_id (see header).
UPDATE "documents" d
SET "owner_id" = first."author_id"
FROM (
    SELECT DISTINCT ON (r."document_id") r."document_id", r."author_id"
      FROM "document_revisions" r
     ORDER BY r."document_id", r."revision_number" ASC
) first
WHERE first."document_id" = d."id"
  AND first."author_id" <> '00000000-0000-0000-0000-000000000000'::uuid
  AND EXISTS (
      SELECT 1 FROM "workspace_members" m
       WHERE m."workspace_id" = d."workspace_id" AND m."user_id" = first."author_id"
  );

-- CreateTable
CREATE TABLE "knowledge_health_settings" (
    "workspace_id" UUID NOT NULL,
    "review_interval_days" INTEGER,
    "remind_before_days" INTEGER,
    "inactive_after_days" INTEGER,
    "empty_max_chars" INTEGER,
    "trust_ranking" BOOLEAN,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "knowledge_health_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateIndex
CREATE INDEX "documents_workspace_id_verification_flag_idx" ON "documents"("workspace_id", "verification_flag");

-- CreateIndex
CREATE INDEX "documents_workspace_id_owner_id_idx" ON "documents"("workspace_id", "owner_id");

-- CreateIndex
CREATE INDEX "documents_workspace_id_verification_expires_at_idx" ON "documents"("workspace_id", "verification_expires_at");

-- CreateIndex
CREATE INDEX "documents_workspace_id_last_activity_at_idx" ON "documents"("workspace_id", "last_activity_at");

-- CreateIndex
CREATE INDEX "documents_workspace_id_archived_at_idx" ON "documents"("workspace_id", "archived_at");
