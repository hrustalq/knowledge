-- #1243: the workspace home layout. Nullable, no backfill: null is the built-in default.
ALTER TABLE "workspace_settings" ADD COLUMN "home_widgets" JSONB;
