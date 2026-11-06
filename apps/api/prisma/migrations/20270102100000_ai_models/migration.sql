-- #798: a provider is a connection, a model is something it serves.
--
-- Expand only, so the previous image still runs against this schema: nothing is
-- dropped, and ai_providers.model gains a default so that image can read a row
-- written after this. The retired columns stop being written and go in a later
-- release. A rollback loses pins and models set after this migration.

CREATE TABLE "ai_models" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider_id" UUID,
    "code" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "in_chat" BOOLEAN NOT NULL DEFAULT true,
    "price_prompt_per_mtok" DECIMAL(12,6),
    "price_completion_per_mtok" DECIMAL(12,6),
    "price_cached_per_mtok" DECIMAL(12,6),
    "price_currency" TEXT,
    "capabilities" JSONB,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_models_workspace_id_provider_id_idx" ON "ai_models"("workspace_id", "provider_id");

-- provider_id is null on the default config's models, which must still be unique
-- per code. Not expressible in Prisma, hence raw. NULLS NOT DISTINCT needs PG 15+.
CREATE UNIQUE INDEX "ai_models_scope_code_key" ON "ai_models"("workspace_id", "provider_id", "code") NULLS NOT DISTINCT;

ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_providers" ALTER COLUMN "model" SET DEFAULT '';

ALTER TABLE "ai_settings"
    ADD COLUMN "chat_model_id" UUID,
    ADD COLUMN "review_model_id" UUID,
    ADD COLUMN "extraction_model_id" UUID,
    ADD COLUMN "decision_model_id" UUID;
ALTER TABLE "ai_agents" ADD COLUMN "model_id" UUID;
ALTER TABLE "assistant_threads" ADD COLUMN "model_id" UUID;

-- Every profile becomes one provider serving one model. The model keeps the
-- profile's id, so a pin copies straight across and a workflow step's stored
-- `providerId` (JSON, not rewritten here) still resolves to the same model.
INSERT INTO "ai_models" (
    "id", "workspace_id", "provider_id", "code", "source", "in_chat",
    "price_prompt_per_mtok", "price_completion_per_mtok", "price_cached_per_mtok", "price_currency",
    "capabilities", "created_by", "created_at", "updated_at"
)
SELECT
    "id", "workspace_id", "id", "model", 'manual', true,
    "price_prompt_per_mtok", "price_completion_per_mtok", "price_cached_per_mtok", "price_currency",
    "capabilities", "created_by", "created_at", "updated_at"
FROM "ai_providers";

UPDATE "ai_settings" SET
    "chat_model_id" = "chat_provider_id",
    "review_model_id" = "review_provider_id",
    "extraction_model_id" = "extraction_provider_id",
    "decision_model_id" = "decision_provider_id";
UPDATE "ai_agents" SET "model_id" = "provider_id" WHERE "provider_id" IS NOT NULL;
UPDATE "assistant_threads" SET "model_id" = "provider_id" WHERE "provider_id" IS NOT NULL;
