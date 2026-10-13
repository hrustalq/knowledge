-- Site Ask (issue #77 phase 3, docs/features/44). Expand-only: every column
-- has a default that keeps an existing site exactly as it was (Ask off, no
-- origin may frame the widget), and the previous release ignores them.

-- AlterTable
ALTER TABLE "published_sites" ADD COLUMN     "ask_daily_budget" INTEGER,
ADD COLUMN     "ask_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "embed_origins" TEXT[] DEFAULT ARRAY[]::TEXT[];
