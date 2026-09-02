-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'other',
ADD COLUMN     "parent_id" UUID;

-- CreateTable
CREATE TABLE "activity_log" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "document_id" UUID,
    "subject_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_log_workspace_id_created_at_idx" ON "activity_log"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_log_document_id_created_at_idx" ON "activity_log"("document_id", "created_at");

-- CreateIndex
CREATE INDEX "documents_workspace_id_category_idx" ON "documents"("workspace_id", "category");

-- CreateIndex
CREATE INDEX "documents_parent_id_idx" ON "documents"("parent_id");
