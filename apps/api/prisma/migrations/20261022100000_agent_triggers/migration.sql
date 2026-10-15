-- Event-triggered agent runs (#70, phase 2). A new table plus two nullable
-- columns on agent_runs: existing runs have no trigger and no subject, so
-- nothing is backfilled. Reversible under expand/contract — the previous
-- release neither reads nor writes any of it.
CREATE TABLE "agent_triggers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "agent_key" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "filter" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "owner_id" UUID,
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
    "note" TEXT,
    "last_fired_at" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_triggers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_triggers_workspace_id_event_enabled_idx" ON "agent_triggers"("workspace_id", "event", "enabled");
CREATE INDEX "agent_triggers_workspace_id_agent_key_idx" ON "agent_triggers"("workspace_id", "agent_key");

-- Hand-written: Prisma cannot express a CHECK. The same values as
-- AGENT_TRIGGER_EVENTS in @knowledge/contracts; phase 3 widens it.
ALTER TABLE "agent_triggers"
  ADD CONSTRAINT "agent_triggers_event_check"
    CHECK ("event" IN ('page.merged', 'page.indexed', 'merge-request.opened', 'connector.synced')),
  ADD CONSTRAINT "agent_triggers_cooldown_check"
    CHECK ("cooldown_minutes" BETWEEN 0 AND 10080);

ALTER TABLE "agent_runs"
  ADD COLUMN "trigger_id" UUID,
  ADD COLUMN "subject_key" TEXT;

CREATE INDEX "agent_runs_workspace_id_agent_key_subject_key_created_at_idx" ON "agent_runs"("workspace_id", "agent_key", "subject_key", "created_at");
CREATE INDEX "agent_runs_trigger_id_subject_key_created_at_idx" ON "agent_runs"("trigger_id", "subject_key", "created_at");
