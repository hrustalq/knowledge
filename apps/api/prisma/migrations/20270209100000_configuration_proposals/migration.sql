-- #1250: the configurator's proposals. A new table, no backfill; dropping it
-- loses only unapplied proposals (applied changes live in their own tables).
CREATE TABLE "configuration_proposals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "goal" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "changes" JSONB NOT NULL DEFAULT '[]',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "configuration_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "configuration_proposals_workspace_id_created_at_idx" ON "configuration_proposals"("workspace_id", "created_at");
