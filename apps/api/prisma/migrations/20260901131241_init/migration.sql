-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_branches" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "head_revision_id" UUID,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_revisions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "content_hash" TEXT,
    "content_type" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "s3_version_id" TEXT,
    "author_id" UUID NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMPTZ,

    CONSTRAINT "document_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revision_parents" (
    "revision_id" UUID NOT NULL,
    "parent_revision_id" UUID NOT NULL,
    "parent_order" SMALLINT NOT NULL DEFAULT 1,

    CONSTRAINT "revision_parents_pkey" PRIMARY KEY ("revision_id","parent_revision_id")
);

-- CreateTable
CREATE TABLE "revision_diffs" (
    "id" UUID NOT NULL,
    "from_revision_id" UUID NOT NULL,
    "to_revision_id" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "changes" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revision_diffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "error" JSONB,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_workspace_id_created_at_idx" ON "documents"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_branches_document_id_name_key" ON "document_branches"("document_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "document_revisions_document_id_revision_number_key" ON "document_revisions"("document_id", "revision_number");

-- CreateIndex
CREATE UNIQUE INDEX "document_revisions_document_id_content_hash_key" ON "document_revisions"("document_id", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "revision_diffs_from_revision_id_to_revision_id_format_key" ON "revision_diffs"("from_revision_id", "to_revision_id", "format");

-- CreateIndex
CREATE INDEX "ingestion_jobs_status_created_at_idx" ON "ingestion_jobs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revision_parents" ADD CONSTRAINT "revision_parents_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "document_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revision_parents" ADD CONSTRAINT "revision_parents_parent_revision_id_fkey" FOREIGN KEY ("parent_revision_id") REFERENCES "document_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
