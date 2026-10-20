-- Search knobs (#305, phase 4): sparse per-workspace overrides of the RRF
-- constant and the trust weights, beside the trust-ranking switch they tune.
-- Additive and nullable, no backfill: null inherits the code default, so an
-- empty column ranks exactly as before, and a previous release never reads it.

-- AlterTable
ALTER TABLE "knowledge_health_settings" ADD COLUMN     "rrf_k" INTEGER,
ADD COLUMN     "trust_weights" JSONB;
