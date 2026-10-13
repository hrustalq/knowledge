-- Published sites (docs/features/44, issue #77 phase 2a). Expand-only: three
-- new tables and one nullable column, so the previous release runs against it
-- unchanged and a rollback needs no down migration.

-- AlterTable
ALTER TABLE "publishing_settings" ADD COLUMN     "allow_public_sites" BOOLEAN;

-- CreateTable
CREATE TABLE "published_sites" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "root_document_id" UUID,
    "theme" JSONB NOT NULL DEFAULT '{}',
    "seo_indexable" BOOLEAN NOT NULL DEFAULT true,
    "default_version_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "published_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_versions" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_branch" TEXT,
    "status" TEXT NOT NULL DEFAULT 'building',
    "built_at" TIMESTAMPTZ,
    "page_count" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_version_pages" (
    "version_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "parent_id" UUID,
    "position" INTEGER NOT NULL,
    "depth" INTEGER NOT NULL,
    "slug_path" TEXT NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "site_version_pages_pkey" PRIMARY KEY ("version_id","document_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "published_sites_project_id_key" ON "published_sites"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "published_sites_slug_key" ON "published_sites"("slug");

-- CreateIndex
CREATE INDEX "published_sites_workspace_id_idx" ON "published_sites"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_versions_site_id_slug_key" ON "site_versions"("site_id", "slug");

-- CreateIndex
CREATE INDEX "site_version_pages_document_id_idx" ON "site_version_pages"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_version_pages_version_id_slug_path_key" ON "site_version_pages"("version_id", "slug_path");

-- AddForeignKey
ALTER TABLE "published_sites" ADD CONSTRAINT "published_sites_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_versions" ADD CONSTRAINT "site_versions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "published_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_version_pages" ADD CONSTRAINT "site_version_pages_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "site_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

