-- #424 tracker handoff, phase 1. Expand-only: every new column is nullable or
-- defaulted and no existing constraint changes, so the previous release's image
-- runs unchanged against this schema (it never writes the new columns).

-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "task_cursor" TEXT;

-- AlterTable
ALTER TABLE "connector_work_items" ADD COLUMN     "external_key" TEXT,
ADD COLUMN     "external_status" TEXT,
ADD COLUMN     "next_sync_at" TIMESTAMPTZ,
ADD COLUMN     "pending_status" TEXT,
ADD COLUMN     "source_id" UUID,
ADD COLUMN     "source_kind" TEXT,
ADD COLUMN     "sync_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sync_error" TEXT,
ADD COLUMN     "sync_state" TEXT NOT NULL DEFAULT 'synced';

-- AlterTable
ALTER TABLE "workspace_settings" ADD COLUMN     "work_item_conflicts" TEXT,
ADD COLUMN     "work_item_issues" TEXT,
ADD COLUMN     "work_item_verification" TEXT;

-- CreateTable
CREATE TABLE "project_tracker_routes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "external_project" TEXT,
    "issue_type" TEXT,
    "board_node_id" TEXT,
    "board_field_id" TEXT,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_tracker_routes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_tracker_routes_project_id_key" ON "project_tracker_routes"("project_id");

-- CreateIndex
CREATE INDEX "project_tracker_routes_workspace_id_idx" ON "project_tracker_routes"("workspace_id");

-- CreateIndex
CREATE INDEX "project_tracker_routes_connector_id_idx" ON "project_tracker_routes"("connector_id");

-- CreateIndex
CREATE INDEX "connector_work_items_source_kind_source_id_idx" ON "connector_work_items"("source_kind", "source_id");

-- CreateIndex
CREATE INDEX "connector_work_items_sync_state_next_sync_at_idx" ON "connector_work_items"("sync_state", "next_sync_at");

-- Backfill: a work item already attached to a page becomes that page's
-- 'document' anchor. One anchor per (connector, page) is the new rule, and a
-- page could be attached to several issues, so only the most recently updated
-- one is anchored; the others keep document_id and stay on the page rail
-- exactly as before.
UPDATE "connector_work_items" w
SET "source_kind" = 'document', "source_id" = w."document_id"
FROM (
  SELECT DISTINCT ON ("connector_id", "document_id") "id"
  FROM "connector_work_items"
  WHERE "document_id" IS NOT NULL
  ORDER BY "connector_id", "document_id", "external_updated_at" DESC NULLS LAST, "id"
) newest
WHERE w."id" = newest."id";

-- CreateIndex
CREATE UNIQUE INDEX "connector_work_items_connector_id_source_kind_source_id_key" ON "connector_work_items"("connector_id", "source_kind", "source_id");

-- AddForeignKey
ALTER TABLE "project_tracker_routes" ADD CONSTRAINT "project_tracker_routes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_tracker_routes" ADD CONSTRAINT "project_tracker_routes_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

