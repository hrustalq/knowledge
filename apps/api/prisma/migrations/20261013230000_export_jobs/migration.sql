-- Exports (issue #77 phase 2c, docs/features/45). Expand-only: a new table,
-- nothing reads it on the previous release, so a rollback leaves it inert.
-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "document_id" UUID,
    "project_id" UUID,
    "branch" TEXT,
    "format" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "page_count" INTEGER,
    "s3_key" TEXT,
    "size_bytes" INTEGER,
    "error" JSONB,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "requested_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "export_jobs_workspace_id_created_at_idx" ON "export_jobs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "export_jobs_status_expires_at_idx" ON "export_jobs"("status", "expires_at");

