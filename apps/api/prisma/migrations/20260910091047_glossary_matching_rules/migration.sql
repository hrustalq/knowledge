-- AlterTable
ALTER TABLE "glossary_terms" ADD COLUMN     "case_sensitive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "match_aliases" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "max_links_per_page" INTEGER;
