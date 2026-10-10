-- Issue #67 phase 3 (docs/features/38): knowledge issues — reported problems
-- with a page. A new table only, so the previous release's image runs against
-- this schema unchanged. One OPEN issue per (document, kind) is a partial
-- unique index Prisma cannot express; the service enforces it with a guarded
-- UPDATE-then-INSERT, and a race at worst folds two reports into two rows.
-- CreateTable
CREATE TABLE "knowledge_issues" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_id" UUID,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "detail" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "suggested_markdown" TEXT,
    "surface" TEXT NOT NULL,
    "report_count" INTEGER NOT NULL DEFAULT 1,
    "agent_run_id" UUID,
    "merge_request_id" UUID,
    "created_by" UUID NOT NULL,
    "api_key_id" UUID,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_issues_workspace_id_status_created_at_idx" ON "knowledge_issues"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "knowledge_issues_document_id_status_idx" ON "knowledge_issues"("document_id", "status");

-- CreateIndex
CREATE INDEX "knowledge_issues_created_by_created_at_idx" ON "knowledge_issues"("created_by", "created_at");
