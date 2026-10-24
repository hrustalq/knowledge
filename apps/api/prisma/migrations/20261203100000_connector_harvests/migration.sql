-- Harvest connectors (#382, doc 59): one row per resolved item, claimed by the
-- webhook and finished by the API-side sweeper. A new table, nothing else
-- touched: the previous release never reads it, so this survives a rollback.
CREATE TABLE "connector_harvests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "locked_at" TIMESTAMPTZ,
    "harvested_at" TIMESTAMPTZ,
    "user_id" UUID,
    "proposed" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_harvests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "connector_harvests_connector_id_external_id_key" ON "connector_harvests"("connector_id", "external_id");
CREATE INDEX "connector_harvests_harvested_at_locked_at_idx" ON "connector_harvests"("harvested_at", "locked_at");

ALTER TABLE "connector_harvests" ADD CONSTRAINT "connector_harvests_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
