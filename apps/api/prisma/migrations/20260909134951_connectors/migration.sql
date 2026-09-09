-- CreateTable
CREATE TABLE "connectors" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "credential" TEXT,
    "credential_hint" TEXT,
    "project_id" UUID NOT NULL,
    "parent_id" UUID,
    "category" TEXT NOT NULL DEFAULT 'other',
    "direction" TEXT NOT NULL DEFAULT 'pull',
    "conflict" TEXT NOT NULL DEFAULT 'manual',
    "push_on_publish" BOOLEAN NOT NULL DEFAULT false,
    "sync_interval_minutes" INTEGER,
    "webhook_secret" TEXT,
    "last_run_id" UUID,
    "last_synced_at" TIMESTAMPTZ,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_links" (
    "id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_url" TEXT,
    "external_title" TEXT,
    "external_version" TEXT,
    "content_hash" TEXT,
    "revision_id" UUID,
    "last_pulled_at" TIMESTAMPTZ,
    "last_pushed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_runs" (
    "id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "progress" DOUBLE PRECISION,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB,
    "error" JSONB,
    "scope" JSONB,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "actor_id" UUID,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connectors_workspace_id_kind_idx" ON "connectors"("workspace_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "connectors_workspace_id_name_key" ON "connectors"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "connector_links_document_id_idx" ON "connector_links"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_links_connector_id_external_id_key" ON "connector_links"("connector_id", "external_id");

-- CreateIndex
CREATE INDEX "connector_runs_connector_id_created_at_idx" ON "connector_runs"("connector_id", "created_at");

-- CreateIndex
CREATE INDEX "connector_runs_status_created_at_idx" ON "connector_runs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_links" ADD CONSTRAINT "connector_links_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
