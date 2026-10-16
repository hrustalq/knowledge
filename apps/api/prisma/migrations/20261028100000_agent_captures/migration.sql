-- Agent-session memory, phase 1 (#73): the capture staging table, merge
-- request provenance, a capture key's project pin and the workspace capture
-- settings. Purely additive — a new table, nullable columns, and one NOT NULL
-- column with a constant default (no backfill: every existing merge request
-- was opened by a person or read as one). Reversible under expand/contract:
-- the previous release ignores all of it.

-- AlterTable
ALTER TABLE "merge_requests" ADD COLUMN     "capture_id" UUID,
ADD COLUMN     "provenance" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "project_ids" JSONB;

-- AlterTable
ALTER TABLE "ai_settings" ADD COLUMN     "capture_amend_threshold" DOUBLE PRECISION,
ADD COLUMN     "capture_dedupe_threshold" DOUBLE PRECISION,
ADD COLUMN     "capture_enabled" BOOLEAN,
ADD COLUMN     "capture_parent_document_id" UUID,
ADD COLUMN     "capture_per_key_per_hour" INTEGER,
ADD COLUMN     "capture_per_workspace_per_day" INTEGER;

-- CreateTable
CREATE TABLE "knowledge_captures" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'staged',
    "outcome" TEXT,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "session" JSONB NOT NULL,
    "similar" JSONB NOT NULL DEFAULT '[]',
    "target_document_id" UUID,
    "merge_request_id" UUID,
    "glossary_term_id" UUID,
    "api_key_id" UUID,
    "created_by" UUID NOT NULL,
    "error" TEXT,
    "claimed_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_captures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_captures_workspace_id_status_created_at_idx" ON "knowledge_captures"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "knowledge_captures_api_key_id_created_at_idx" ON "knowledge_captures"("api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "knowledge_captures_project_id_content_hash_idx" ON "knowledge_captures"("project_id", "content_hash");

-- Hand-written: Prisma cannot express a CHECK. The same lists as
-- CAPTURE_KINDS, CAPTURE_STATUSES, CAPTURE_OUTCOMES and MR_PROVENANCES in
-- @knowledge/contracts/captures — change them together.
ALTER TABLE "knowledge_captures"
  ADD CONSTRAINT "knowledge_captures_kind_check"
    CHECK ("kind" IN ('decision', 'gotcha', 'convention', 'howto', 'glossary', 'relation', 'answer')),
  ADD CONSTRAINT "knowledge_captures_status_check"
    CHECK ("status" IN ('staged', 'proposed', 'duplicate', 'rejected', 'failed')),
  ADD CONSTRAINT "knowledge_captures_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('new-page', 'amend-page', 'glossary', 'relation', 'none'));

ALTER TABLE "merge_requests"
  ADD CONSTRAINT "merge_requests_provenance_check"
    CHECK ("provenance" IN ('manual', 'agent', 'captured'));
