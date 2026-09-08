-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "parent_id" UUID,
    "category" TEXT NOT NULL DEFAULT 'other',
    "status" TEXT NOT NULL DEFAULT 'awaiting-upload',
    "stage" TEXT,
    "progress" DOUBLE PRECISION,
    "source_filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "s3_key" TEXT NOT NULL,
    "parser" TEXT,
    "title" TEXT,
    "warnings" JSONB,
    "meta" JSONB,
    "error" JSONB,
    "document_id" UUID,
    "created_by" UUID,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_jobs_workspace_id_created_at_idx" ON "import_jobs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "import_jobs_status_created_at_idx" ON "import_jobs"("status", "created_at");
