-- AlterTable
ALTER TABLE "ai_settings" ADD COLUMN     "chat_provider_id" UUID,
ADD COLUMN     "extraction_provider_id" UUID,
ADD COLUMN     "review_provider_id" UUID;

-- AlterTable
ALTER TABLE "ai_usage" ADD COLUMN     "provider_id" UUID;

-- AlterTable
ALTER TABLE "assistant_threads" ADD COLUMN     "provider_id" UUID;

-- CreateTable
CREATE TABLE "ai_providers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "base_url" TEXT,
    "model" TEXT NOT NULL,
    "api_key_cipher" TEXT,
    "temperature" DOUBLE PRECISION,
    "max_tool_calls" INTEGER,
    "timeout_ms" INTEGER,
    "price_prompt_per_mtok" DECIMAL(12,6),
    "price_completion_per_mtok" DECIMAL(12,6),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_status" TEXT,
    "last_error" TEXT,
    "last_checked_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_providers_workspace_id_created_at_idx" ON "ai_providers"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_providers_workspace_id_name_key" ON "ai_providers"("workspace_id", "name");
