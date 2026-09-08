-- AI settings (docs/features/12): the assistant layer made administrable per
-- workspace instead of per boot. ai_settings/ai_user_budgets hold OVERRIDES —
-- a null column means "inherit the ASSISTANT_* env var" — so an empty set of
-- tables reproduces the pre-migration behaviour exactly. ai_skills are trusted
-- instruction packs merged into the system prompt; ai_plugins are external MCP
-- servers whose tools join the bounded tool harness; ai_usage is one row per
-- upstream LLM call, serving both the usage aggregates and the call log.
-- workspace_id carries no FK, mirroring documents.workspace_id.

-- CreateTable
CREATE TABLE "ai_settings" (
    "workspace_id" UUID NOT NULL,
    "provider" TEXT,
    "base_url" TEXT,
    "model" TEXT,
    "api_key_cipher" TEXT,
    "temperature" DOUBLE PRECISION,
    "max_tool_calls" INTEGER,
    "timeout_ms" INTEGER,
    "agent_mode_enabled" BOOLEAN NOT NULL DEFAULT true,
    "price_prompt_per_mtok" DECIMAL(12,6),
    "price_completion_per_mtok" DECIMAL(12,6),
    "workspace_monthly_token_budget" BIGINT,
    "default_user_monthly_token_budget" BIGINT,
    "enforce_budget" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "ai_user_budgets" (
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "monthly_token_budget" BIGINT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_user_budgets_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- CreateTable
CREATE TABLE "ai_skills" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "triggers" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_plugins" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'streamable-http',
    "url" TEXT NOT NULL,
    "auth_header" TEXT,
    "auth_value_cipher" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabled_tools" JSONB NOT NULL DEFAULT '[]',
    "discovered_tools" JSONB NOT NULL DEFAULT '[]',
    "last_status" TEXT,
    "last_error" TEXT,
    "last_checked_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_plugins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "cost_usd_micros" INTEGER,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error_code" TEXT,
    "error" TEXT,
    "thread_id" UUID,
    "tool_call_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_skills_workspace_id_created_at_idx" ON "ai_skills"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_skills_workspace_id_name_key" ON "ai_skills"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "ai_plugins_workspace_id_created_at_idx" ON "ai_plugins"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_plugins_workspace_id_name_key" ON "ai_plugins"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "ai_usage_workspace_id_created_at_idx" ON "ai_usage"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_workspace_id_user_id_created_at_idx" ON "ai_usage"("workspace_id", "user_id", "created_at");
