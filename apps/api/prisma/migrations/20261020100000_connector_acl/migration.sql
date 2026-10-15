-- Connector ACL mirroring (#76, phase 6). Additive only: every new column is
-- nullable or defaulted, so the previous release's image runs against it and
-- `acl_mode = 'off'` reproduces today's behaviour.

ALTER TABLE "connectors"
  ADD COLUMN "acl_mode" TEXT NOT NULL DEFAULT 'off',
  ADD COLUMN "acl_sync_interval_minutes" INTEGER,
  ADD COLUMN "acl_audience_group_id" UUID,
  ADD COLUMN "acl_synced_at" TIMESTAMPTZ;

ALTER TABLE "connector_links"
  ADD COLUMN "acl_hash" TEXT,
  ADD COLUMN "acl_restricted" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "connector_run_items" ADD COLUMN "acl" JSONB;

CREATE TABLE "external_identities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_name" TEXT,
    "email" TEXT,
    "user_id" UUID,
    "mapped_by" TEXT,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_identities_connector_id_external_id_key" ON "external_identities"("connector_id", "external_id");
CREATE INDEX "external_identities_workspace_id_user_id_idx" ON "external_identities"("workspace_id", "user_id");

ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_connector_id_fkey"
  FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The sync rewrites one connector's grants on one page; this is its lookup.
CREATE INDEX "access_grants_connector_id_idx" ON "access_grants"("connector_id");
