-- #958 editing policy: how a person's edit reaches a published page
-- (review | direct), who reads page history (everyone | editors) and how many
-- approvals a merge needs. All nullable, null = today's behaviour, so the
-- previous image runs against it unchanged and no backfill is needed.
ALTER TABLE "workspace_settings"
  ADD COLUMN "publish_mode" TEXT,
  ADD COLUMN "history_audience" TEXT,
  ADD COLUMN "required_approvals" INTEGER;
