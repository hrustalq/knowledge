-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "graph" JSONB NOT NULL,
    "trigger" JSONB,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "definition_snapshot" JSONB NOT NULL,
    "definition_version" INTEGER NOT NULL DEFAULT 1,
    "root_document_id" UUID NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "snapshot" JSONB,
    "error" TEXT,
    "started_by" TEXT,
    "created_by" UUID,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run_nodes" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "parent_id" UUID,
    "step_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "input" JSONB,
    "draft" JSONB,
    "output" JSONB,
    "document_id" UUID,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workflow_run_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_definitions_workspace_id_project_id_idx" ON "workflow_definitions"("workspace_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_workspace_id_name_key" ON "workflow_definitions"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "workflow_runs_workspace_id_status_created_at_idx" ON "workflow_runs"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "workflow_runs_root_document_id_idx" ON "workflow_runs"("root_document_id");

-- CreateIndex
CREATE INDEX "workflow_runs_definition_id_root_document_id_status_idx" ON "workflow_runs"("definition_id", "root_document_id", "status");

-- CreateIndex
CREATE INDEX "workflow_run_nodes_run_id_status_idx" ON "workflow_run_nodes"("run_id", "status");

-- CreateIndex
CREATE INDEX "workflow_run_nodes_document_id_idx" ON "workflow_run_nodes"("document_id");

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "workflow_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run_nodes" ADD CONSTRAINT "workflow_run_nodes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run_nodes" ADD CONSTRAINT "workflow_run_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "workflow_run_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
