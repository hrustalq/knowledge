-- API reference documents, phase 1 (#78): a document kind, a pinned spec slug,
-- and the per-revision operation projection. Additive: a defaulted column, a
-- nullable one and a new table, so the previous release ignores all three and
-- a rollback is safe. `kind` defaults to 'page', which is what every existing
-- row is, so there is nothing to backfill.

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'page',
ADD COLUMN     "spec_slug" TEXT;

-- CreateTable
CREATE TABLE "api_operations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "protocol" TEXT NOT NULL,
    "method" TEXT,
    "path" TEXT NOT NULL,
    "operation_id" TEXT,
    "entity_key" TEXT NOT NULL,
    "summary" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "pointer" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_operations_workspace_id_entity_key_idx" ON "api_operations"("workspace_id", "entity_key");

-- CreateIndex
CREATE INDEX "api_operations_document_id_revision_id_idx" ON "api_operations"("document_id", "revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_operations_revision_id_entity_key_method_key" ON "api_operations"("revision_id", "entity_key", "method");

-- CreateIndex
CREATE INDEX "documents_workspace_id_kind_idx" ON "documents"("workspace_id", "kind");

-- AddForeignKey
ALTER TABLE "api_operations" ADD CONSTRAINT "api_operations_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

