-- #78 phase 4: a sparse per-workspace settings row. A new table and no
-- backfill: an empty table means every workspace inherits the env, so the
-- previous release's image never reads it and a rollback leaves it inert.
CREATE TABLE "workspace_settings" (
    "workspace_id" UUID NOT NULL,
    "api_try_proxy_mode" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "workspace_settings_pkey" PRIMARY KEY ("workspace_id")
);
