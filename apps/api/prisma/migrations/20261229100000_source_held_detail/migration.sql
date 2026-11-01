-- #674 phase 4: the parser's message for a held spec source.
-- Nullable and additive: the previous release ignores it.
ALTER TABLE "connector_links" ADD COLUMN "held_detail" TEXT;
