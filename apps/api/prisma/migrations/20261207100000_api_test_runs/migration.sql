-- QA server runner (#483, phase 5): test environments, run records, and the
-- workspace's switch. Survives a rollback: earlier releases read neither table,
-- and the new settings column is nullable (null is off).
ALTER TABLE "workspace_settings" ADD COLUMN "api_test_runner" TEXT;

CREATE TABLE "api_test_environments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "server" TEXT,
    "inputs" JSONB NOT NULL DEFAULT '{}',
    "secrets_cipher" TEXT,
    "secret_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "api_test_environments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "api_test_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "entity_key" TEXT NOT NULL,
    "environment_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "plan" JSONB NOT NULL,
    "results" JSONB NOT NULL DEFAULT '{}',
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "not_run" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "api_test_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_test_environments_workspace_id_name_key" ON "api_test_environments"("workspace_id", "name");

CREATE INDEX "api_test_runs_document_id_entity_key_created_at_idx" ON "api_test_runs"("document_id", "entity_key", "created_at" DESC);

ALTER TABLE "api_test_runs" ADD CONSTRAINT "api_test_runs_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "api_test_runs" ADD CONSTRAINT "api_test_runs_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "api_test_environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
