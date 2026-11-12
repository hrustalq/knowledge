-- #934 workspace purpose: what a workspace is used for (WORKSPACE_USES values),
-- the admin's own words, and when the first-visit question was settled.
-- Additive and defaulted, so the previous image runs against it unchanged.
ALTER TABLE "workspace_settings"
  ADD COLUMN "purpose_uses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "purpose_description" TEXT,
  ADD COLUMN "purpose_asked_at" TIMESTAMPTZ;

-- Every workspace that exists today counts as asked: its admin is never sent
-- to the wizard and no section of it is re-toggled. `updated_at` has no
-- database default, so the insert names it.
INSERT INTO "workspace_settings" ("workspace_id", "purpose_asked_at", "updated_at")
SELECT "id", now(), now() FROM "workspaces"
ON CONFLICT ("workspace_id") DO UPDATE SET "purpose_asked_at" = now();
