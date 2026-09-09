-- CreateTable
CREATE TABLE "connector_conflicts" (
    "id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "branch" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "external_url" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "merge_request_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "connector_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connector_conflicts_status_created_at_idx" ON "connector_conflicts"("status", "created_at");

-- CreateIndex
CREATE INDEX "connector_conflicts_connector_id_created_at_idx" ON "connector_conflicts"("connector_id", "created_at");

-- AddForeignKey
ALTER TABLE "connector_conflicts" ADD CONSTRAINT "connector_conflicts_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
