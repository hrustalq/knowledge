-- Agent learnings (#70, phase 5). A new table only: finding dismissal lives in
-- the agent_runs.findings JSON (dismissedAt / dismissedBy / learningId), so no
-- existing column changes. Reversible under expand/contract — the previous
-- release neither reads nor writes any of it.
CREATE TABLE "agent_learnings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "agent_key" TEXT,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "source_kind" TEXT NOT NULL DEFAULT 'manual',
    "source_id" UUID,
    "document_id" UUID,
    "merge_request_id" UUID,
    "run_id" UUID,
    "finding_index" INTEGER,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_learnings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_learnings_workspace_id_agent_key_status_idx" ON "agent_learnings"("workspace_id", "agent_key", "status");
CREATE INDEX "agent_learnings_run_id_finding_index_idx" ON "agent_learnings"("run_id", "finding_index");

-- Hand-written: Prisma cannot express a CHECK. The same values as
-- AGENT_LEARNING_STATUSES / AGENT_LEARNING_SOURCES / AGENT_LEARNING_MAX_CHARS
-- in @knowledge/contracts.
ALTER TABLE "agent_learnings"
  ADD CONSTRAINT "agent_learnings_status_check"
    CHECK ("status" IN ('proposed', 'active', 'archived')),
  ADD CONSTRAINT "agent_learnings_source_kind_check"
    CHECK ("source_kind" IN ('document-thread', 'mr-thread', 'finding', 'manual')),
  ADD CONSTRAINT "agent_learnings_text_check"
    CHECK (char_length("text") BETWEEN 1 AND 1000);
