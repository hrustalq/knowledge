-- AlterTable
ALTER TABLE "connector_runs" ADD COLUMN     "applied" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cursor" JSONB,
ADD COLUMN     "discovered" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'auto',
ADD COLUMN     "phase" TEXT,
ADD COLUMN     "reverted" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "preserve_hierarchy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sync_mode" TEXT NOT NULL DEFAULT 'auto';

-- CreateTable
CREATE TABLE "connector_run_items" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "parent_item_id" UUID,
    "external_id" TEXT NOT NULL,
    "external_parent_id" TEXT,
    "external_url" TEXT,
    "external_version" TEXT,
    "title" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "has_children" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'discovered',
    "action" TEXT,
    "draft" JSONB,
    "content_hash" TEXT,
    "staged_key" TEXT,
    "incoming_key" TEXT,
    "document_id" UUID,
    "link_id" UUID,
    "revision_id" UUID,
    "previous_revision_id" UUID,
    "created_document" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "connector_run_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connector_run_items_run_id_status_idx" ON "connector_run_items"("run_id", "status");

-- CreateIndex
CREATE INDEX "connector_run_items_run_id_parent_item_id_idx" ON "connector_run_items"("run_id", "parent_item_id");

-- CreateIndex
CREATE INDEX "connector_run_items_document_id_idx" ON "connector_run_items"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_run_items_run_id_external_id_key" ON "connector_run_items"("run_id", "external_id");

-- AddForeignKey
ALTER TABLE "connector_run_items" ADD CONSTRAINT "connector_run_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "connector_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_run_items" ADD CONSTRAINT "connector_run_items_parent_item_id_fkey" FOREIGN KEY ("parent_item_id") REFERENCES "connector_run_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
