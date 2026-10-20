-- #81 phase 5: contradictions the arbiter finds between pages. A new table only;
-- no FK on workspace_id, document, revision, run or user columns (house policy).
-- CreateTable
CREATE TABLE "knowledge_conflicts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "fingerprint" TEXT NOT NULL,
    "a_document_id" UUID NOT NULL,
    "a_revision_id" UUID NOT NULL,
    "a_chunk_id" TEXT,
    "a_quote" TEXT NOT NULL,
    "b_document_id" UUID,
    "b_revision_id" UUID,
    "b_chunk_id" TEXT,
    "b_quote" TEXT,
    "code_ref" JSONB,
    "explanation" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "agent_run_id" UUID,
    "finding_index" INTEGER,
    "merge_request_id" UUID,
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,
    "resolved_by" UUID,
    "resolution" TEXT,

    CONSTRAINT "knowledge_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_conflicts_workspace_id_status_detected_at_idx" ON "knowledge_conflicts"("workspace_id", "status", "detected_at");

-- CreateIndex
CREATE INDEX "knowledge_conflicts_a_document_id_status_idx" ON "knowledge_conflicts"("a_document_id", "status");

-- CreateIndex
CREATE INDEX "knowledge_conflicts_b_document_id_status_idx" ON "knowledge_conflicts"("b_document_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_conflicts_workspace_id_fingerprint_key" ON "knowledge_conflicts"("workspace_id", "fingerprint");

