-- Site audiences (issue #77 phase 3, docs/features/44). Expand-only: the
-- snapshot columns default to 'public', which is what every existing row is.

-- AlterTable
ALTER TABLE "published_sites" ADD COLUMN     "visitor_secret_cipher" TEXT,
ADD COLUMN     "visitor_secret_set_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "site_version_pages" ADD COLUMN     "audience" TEXT NOT NULL DEFAULT 'public',
ADD COLUMN     "audience_claims" JSONB;

-- CreateTable
CREATE TABLE "site_audience_rules" (
    "site_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "audience" TEXT NOT NULL,
    "claims" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "site_audience_rules_pkey" PRIMARY KEY ("site_id","document_id")
);

-- CreateIndex
CREATE INDEX "site_audience_rules_document_id_idx" ON "site_audience_rules"("document_id");

-- AddForeignKey
ALTER TABLE "site_audience_rules" ADD CONSTRAINT "site_audience_rules_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "published_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_audience_rules" ADD CONSTRAINT "site_audience_rules_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

