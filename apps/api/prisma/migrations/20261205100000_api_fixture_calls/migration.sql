-- QA test fixtures (#483, phase 1): one row per `call` step of a fixture
-- revision. `documents.kind` is text, so the `test-fixture` kind itself needs
-- no migration. Additive only: a new table the previous release never reads,
-- so this survives a rollback.
CREATE TABLE "api_fixture_calls" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "step_id" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "entity_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_fixture_calls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_fixture_calls_revision_id_step_id_key" ON "api_fixture_calls"("revision_id", "step_id");

CREATE INDEX "api_fixture_calls_workspace_id_entity_key_idx" ON "api_fixture_calls"("workspace_id", "entity_key");

ALTER TABLE "api_fixture_calls" ADD CONSTRAINT "api_fixture_calls_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
