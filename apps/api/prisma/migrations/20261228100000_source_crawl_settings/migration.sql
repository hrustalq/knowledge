-- #674 phase 3: crawl limits, sparse (null = the WEB_SOURCE_CRAWL_* ceiling).
-- Nullable and additive: the previous release ignores them.
ALTER TABLE "workspace_settings" ADD COLUMN "source_crawl_max_pages" INTEGER;
ALTER TABLE "workspace_settings" ADD COLUMN "source_crawl_confirm_first" INTEGER;
ALTER TABLE "workspace_settings" ADD COLUMN "source_crawl_confirm_change" INTEGER;
