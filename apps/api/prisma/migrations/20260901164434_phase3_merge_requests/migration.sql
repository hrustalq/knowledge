-- DropIndex
DROP INDEX "document_revisions_document_id_content_hash_key";

-- CreateTable
CREATE TABLE "merge_requests" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "source_branch_id" UUID NOT NULL,
    "target_branch_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "author_id" UUID NOT NULL,
    "approved_by" JSONB NOT NULL DEFAULT '[]',
    "strategy" TEXT,
    "merged_revision_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "merged_at" TIMESTAMPTZ,
    "closed_at" TIMESTAMPTZ,

    CONSTRAINT "merge_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merge_requests_document_id_status_idx" ON "merge_requests"("document_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "document_revisions_document_id_branch_id_content_hash_key" ON "document_revisions"("document_id", "branch_id", "content_hash");

-- AddForeignKey
ALTER TABLE "merge_requests" ADD CONSTRAINT "merge_requests_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_requests" ADD CONSTRAINT "merge_requests_source_branch_id_fkey" FOREIGN KEY ("source_branch_id") REFERENCES "document_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_requests" ADD CONSTRAINT "merge_requests_target_branch_id_fkey" FOREIGN KEY ("target_branch_id") REFERENCES "document_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

