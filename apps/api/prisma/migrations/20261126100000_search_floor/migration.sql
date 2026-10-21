-- Search relevance floor (#401): sparse per-workspace overrides of the vector
-- leg's absolute cosine floor and its share-of-best floor, beside the other
-- search knobs. Additive and nullable, no backfill: null inherits
-- SEARCH_MIN_COSINE / SEARCH_MIN_COSINE_SHARE, and a previous release never
-- reads them.

-- AlterTable
ALTER TABLE "knowledge_health_settings" ADD COLUMN     "min_cosine" DOUBLE PRECISION,
ADD COLUMN     "min_cosine_share" DOUBLE PRECISION;
