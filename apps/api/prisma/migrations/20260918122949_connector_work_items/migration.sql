-- CreateTable
CREATE TABLE "connector_work_items" (
    "id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "url" TEXT NOT NULL,
    "author_login" TEXT,
    "assignee_logins" JSONB NOT NULL DEFAULT '[]',
    "labels" JSONB NOT NULL DEFAULT '[]',
    "boards" JSONB NOT NULL DEFAULT '[]',
    "document_id" UUID,
    "external_created_at" TIMESTAMPTZ,
    "external_updated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "connector_work_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connector_work_items_connector_id_state_external_updated_at_idx" ON "connector_work_items"("connector_id", "state", "external_updated_at");

-- CreateIndex
CREATE INDEX "connector_work_items_document_id_idx" ON "connector_work_items"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_work_items_connector_id_kind_number_key" ON "connector_work_items"("connector_id", "kind", "number");

-- AddForeignKey
ALTER TABLE "connector_work_items" ADD CONSTRAINT "connector_work_items_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
