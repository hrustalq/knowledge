-- QA test suites (#468, doc 52): member capabilities and the suite cache.
-- Additive only: a new column with a default (existing members start without
-- any capability; nothing is backfilled) and a new table. The previous release
-- reads neither, so this survives a rollback.
ALTER TABLE "workspace_members" ADD COLUMN "capabilities" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "api_test_suites" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "entity_key" TEXT NOT NULL,
    "operation_hash" TEXT NOT NULL,
    "catalogue_version" INTEGER NOT NULL,
    "agent_hash" TEXT NOT NULL,
    "cases" JSONB NOT NULL,
    "revision_id" UUID NOT NULL,
    "agent_run_id" UUID,
    "generated_by" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "api_test_suites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_test_suites_document_id_entity_key_operation_hash_catal_key" ON "api_test_suites"("document_id", "entity_key", "operation_hash", "catalogue_version", "agent_hash");

ALTER TABLE "api_test_suites" ADD CONSTRAINT "api_test_suites_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
