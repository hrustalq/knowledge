-- AlterTable
ALTER TABLE "ai_providers" ADD COLUMN     "capabilities" JSONB;

-- CreateTable
CREATE TABLE "ai_agents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "built_in" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "description" TEXT,
    "instructions" TEXT,
    "tools" JSONB,
    "skill_ids" JSONB,
    "provider_id" UUID,
    "temperature" DOUBLE PRECISION,
    "max_tool_calls" INTEGER,
    "timeout_ms" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_agents_workspace_id_created_at_idx" ON "ai_agents"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agents_workspace_id_key_key" ON "ai_agents"("workspace_id", "key");
