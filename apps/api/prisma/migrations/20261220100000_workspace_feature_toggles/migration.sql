-- #604 feature toggles: the sections a workspace admin switched off.
-- Additive with a default, so the previous release's image never reads it.
ALTER TABLE "workspace_settings" ADD COLUMN "disabled_features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
