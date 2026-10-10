-- Issue #67 phase 2 (docs/features/38): votes and implicit signals on answers.
-- A new table only — nothing existing changes, so the previous release's
-- image runs against this schema unchanged. One vote per person per message is
-- the unique index; rows with no message (ask, mcp) are exempt by NULL.
-- CreateTable
CREATE TABLE "answer_feedback" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "rating" TEXT,
    "reason" TEXT,
    "comment" TEXT,
    "query" TEXT NOT NULL,
    "answer_excerpt" TEXT,
    "thread_id" UUID,
    "message_id" UUID,
    "trace_id" TEXT,
    "cited_document_ids" JSONB NOT NULL DEFAULT '[]',
    "confidence" JSONB,
    "created_by" UUID NOT NULL,
    "api_key_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answer_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "answer_feedback_workspace_id_created_at_idx" ON "answer_feedback"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "answer_feedback_workspace_id_kind_created_at_idx" ON "answer_feedback"("workspace_id", "kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "answer_feedback_message_id_created_by_key" ON "answer_feedback"("message_id", "created_by");
