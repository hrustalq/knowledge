-- #921: a project may override the workspace's freshness thresholds.
-- Nullable, no backfill: null inherits, so every project behaves as before.
ALTER TABLE "projects"
  ADD COLUMN "review_interval_days" INTEGER,
  ADD COLUMN "remind_before_days" INTEGER,
  ADD COLUMN "inactive_after_days" INTEGER,
  ADD COLUMN "empty_max_chars" INTEGER;
