-- The step log of a background agent run (#1247): each model call, tool call
-- and warning, appended by the worker while the run is `running`. Expand-only:
-- the previous image never reads or writes it, so a rollback by retag is safe
-- (its runs simply stop appending steps).
CREATE TABLE "agent_run_steps" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "args" TEXT,
    "output" TEXT,
    "sources" JSONB,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "tokens" INTEGER,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_steps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_run_steps_run_id_id_idx" ON "agent_run_steps"("run_id", "id");
CREATE INDEX "agent_run_steps_workspace_id_idx" ON "agent_run_steps"("workspace_id");

ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The run page's token and cost total reads a run's ai_usage rows by run id.
CREATE INDEX "ai_usage_agent_run_id_idx" ON "ai_usage"("agent_run_id");
