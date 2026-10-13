-- Site domains and the stuck-build clock (docs/features/44, issue #77 phase 2b).
-- Expand-only: one new table and one column with a default, so the previous
-- release runs against it unchanged and a rollback needs no down migration.

-- AlterTable
ALTER TABLE "site_versions" ADD COLUMN     "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "site_domains" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "verify_token" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ,
    "last_check_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_domains_hostname_key" ON "site_domains"("hostname");

-- CreateIndex
CREATE INDEX "site_domains_site_id_idx" ON "site_domains"("site_id");

-- AddForeignKey
ALTER TABLE "site_domains" ADD CONSTRAINT "site_domains_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "published_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

