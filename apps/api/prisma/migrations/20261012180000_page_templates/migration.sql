-- Page templates (issue #69). Expand-only: two nullable columns on documents
-- and two new tables, so the previous image runs against this schema unchanged
-- and a code rollback needs no database step. Built-in templates live in code
-- and are never seeded here.

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "template_ref" TEXT,
ADD COLUMN     "template_version" INTEGER;

-- CreateTable
CREATE TABLE "page_templates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "built_in_key" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "category" TEXT NOT NULL DEFAULT 'other',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "page_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_template_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "meta" JSONB NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "page_templates_workspace_id_project_id_idx" ON "page_templates"("workspace_id", "project_id");

-- CreateIndex
CREATE INDEX "page_templates_workspace_id_built_in_key_idx" ON "page_templates"("workspace_id", "built_in_key");

-- CreateIndex
CREATE UNIQUE INDEX "page_template_versions_template_id_version_key" ON "page_template_versions"("template_id", "version");

-- AddForeignKey
ALTER TABLE "page_template_versions" ADD CONSTRAINT "page_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "page_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

