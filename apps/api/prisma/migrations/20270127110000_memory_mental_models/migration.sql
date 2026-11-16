-- Refreshable, bank-local mental models (#1160). Expand-only: the previous
-- image never reads these tables or the nullable operation scheduling column.

CREATE TABLE "memory_mental_models" (
    "id" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source_query" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "max_tokens" INTEGER NOT NULL DEFAULT 4096,
    "trigger" JSONB NOT NULL DEFAULT '{}',
    "reflect_response" JSONB,
    "structured_doc" JSONB,
    "refreshed_source_query" TEXT,
    "last_refreshed_at" TIMESTAMPTZ,
    "last_memory_seen_at" TIMESTAMPTZ,
    "last_refresh_failed_at" TIMESTAMPTZ,
    "last_full_refreshed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_mental_models_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memory_mental_models_workspace_id_idx" ON "memory_mental_models"("workspace_id");
CREATE INDEX "memory_mental_models_bank_id_created_at_idx" ON "memory_mental_models"("bank_id", "created_at");

CREATE TABLE "memory_mental_model_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "model_id" TEXT NOT NULL,
    "previous_content" TEXT,
    "kind" TEXT,
    "outcome" TEXT,
    "failure_reason" TEXT,
    "error_message" TEXT,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_mental_model_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memory_mental_model_history_workspace_id_idx" ON "memory_mental_model_history"("workspace_id");
CREATE INDEX "memory_mental_model_history_model_id_changed_at_idx" ON "memory_mental_model_history"("model_id", "changed_at");

ALTER TABLE "memory_mental_models" ADD CONSTRAINT "memory_mental_models_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "memory_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_mental_model_history" ADD CONSTRAINT "memory_mental_model_history_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "memory_mental_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_operations" ADD COLUMN "not_before" TIMESTAMPTZ;
CREATE INDEX "memory_operations_status_not_before_idx" ON "memory_operations"("status", "not_before");
