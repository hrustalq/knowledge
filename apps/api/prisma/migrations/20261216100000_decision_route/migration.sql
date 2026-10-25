-- #530: the `decision` purpose's route and its pre-filter thresholds. All
-- nullable and additive: null routes nothing and inherits the code defaults
-- (DECISION_THRESHOLDS), so an empty row behaves as before. The previous
-- release's image ignores the columns, so this survives a rollback.
ALTER TABLE "ai_settings"
  ADD COLUMN "decision_provider_id" UUID,
  ADD COLUMN "decision_arbiter_threshold" DOUBLE PRECISION,
  ADD COLUMN "decision_citation_threshold" DOUBLE PRECISION,
  ADD COLUMN "decision_harvest_threshold" DOUBLE PRECISION,
  ADD COLUMN "decision_tuned_model" TEXT;
