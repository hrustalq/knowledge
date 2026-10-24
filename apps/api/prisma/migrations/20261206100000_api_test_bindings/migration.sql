-- QA fixture bindings (#483, phase 2): which fixtures set up an operation's
-- suite, and the bound fixtures' content as part of the suite cache key.
-- Survives a rollback: v0.32.0 reads neither table (api_test_suites ships in
-- the same release), and the new column has a default.
ALTER TABLE "api_test_suites" ADD COLUMN "fixtures_hash" TEXT NOT NULL DEFAULT '';

DROP INDEX "api_test_suites_document_id_entity_key_operation_hash_catal_key";

CREATE UNIQUE INDEX "api_test_suites_key" ON "api_test_suites"("document_id", "entity_key", "operation_hash", "catalogue_version", "agent_hash", "fixtures_hash");

CREATE TABLE "api_test_bindings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "entity_key" TEXT NOT NULL,
    "case_id" TEXT,
    "fixture_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_test_bindings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "api_test_bindings_document_id_entity_key_idx" ON "api_test_bindings"("document_id", "entity_key");

CREATE INDEX "api_test_bindings_fixture_id_idx" ON "api_test_bindings"("fixture_id");

ALTER TABLE "api_test_bindings" ADD CONSTRAINT "api_test_bindings_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "api_test_bindings" ADD CONSTRAINT "api_test_bindings_fixture_id_fkey" FOREIGN KEY ("fixture_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
