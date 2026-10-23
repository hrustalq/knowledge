-- #475: the community prior and layered expansion, sparse like every search
-- knob — null inherits the code default (prior weight 0, floor 0.5, flat
-- expansion), so an empty row ranks exactly as before. Nullable columns on an
-- existing table: no backfill, and the previous image never reads them.
ALTER TABLE "knowledge_health_settings"
  ADD COLUMN "community_prior_weight" DOUBLE PRECISION,
  ADD COLUMN "community_prior_floor" DOUBLE PRECISION,
  ADD COLUMN "layered_expansion" BOOLEAN;
