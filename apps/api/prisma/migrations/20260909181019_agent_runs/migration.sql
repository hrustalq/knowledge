-- AlterTable
ALTER TABLE "ai_agents" ADD COLUMN     "last_run_at" TIMESTAMPTZ,
ADD COLUMN     "schedule_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "schedule_minutes" INTEGER,
ADD COLUMN     "schedule_note" TEXT,
ADD COLUMN     "schedule_owner" UUID;

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "agent_key" TEXT NOT NULL,
    "agent_id" UUID,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by" UUID NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "input" JSONB,
    "findings" JSONB,
    "summary" TEXT,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_status_created_at_idx" ON "agent_runs"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_agent_key_created_at_idx" ON "agent_runs"("workspace_id", "agent_key", "created_at");

-- CreateIndex
CREATE INDEX "ai_agents_schedule_enabled_last_run_at_idx" ON "ai_agents"("schedule_enabled", "last_run_at");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
