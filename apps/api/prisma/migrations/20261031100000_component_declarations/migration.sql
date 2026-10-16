-- Component pages, phase 2 (#236): the code a page declares it documents.
-- Additive — one new table, written by ingestion and the codebase pull — so the
-- previous release ignores it and a rollback is safe. It starts empty and fills
-- as pages with a `component:` block are next indexed (any edit, or a reindex).

-- CreateTable
CREATE TABLE "component_declarations" (
    "document_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "component_key" TEXT NOT NULL,
    "component_name" TEXT NOT NULL,
    "repository" TEXT,
    "connector_id" UUID,
    "paths" TEXT[],
    "symbols" TEXT[],
    "warning" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "component_declarations_pkey" PRIMARY KEY ("document_id")
);

-- CreateIndex
CREATE INDEX "component_declarations_workspace_id_idx" ON "component_declarations"("workspace_id");

-- CreateIndex
CREATE INDEX "component_declarations_connector_id_idx" ON "component_declarations"("connector_id");

-- AddForeignKey
ALTER TABLE "component_declarations" ADD CONSTRAINT "component_declarations_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_declarations" ADD CONSTRAINT "component_declarations_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
