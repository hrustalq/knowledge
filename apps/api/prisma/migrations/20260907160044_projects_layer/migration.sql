-- Workspace > Project > Document.
--
-- Hand-edited after `prisma migrate dev --create-only`: documents.project_id is
-- NOT NULL, so the column is added nullable, backfilled from a "General"
-- project per workspace, and only then constrained.

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_workspace_id_created_at_idx" ON "projects"("workspace_id", "created_at");

-- Backfill: one "General" project per workspace that owns documents, plus every
-- registered workspace, so empty workspaces are usable straight away.
INSERT INTO "projects" ("id", "workspace_id", "name", "description")
SELECT gen_random_uuid(), s.ws, 'General', 'Default project created when projects were introduced.'
FROM (
    SELECT DISTINCT "workspace_id" AS ws FROM "documents"
    UNION
    SELECT "id" FROM "workspaces"
) s;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN "project_id" UUID;

UPDATE "documents" d
SET "project_id" = p."id"
FROM "projects" p
WHERE p."workspace_id" = d."workspace_id";

ALTER TABLE "documents" ALTER COLUMN "project_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "documents_project_id_created_at_idx" ON "documents"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "documents_project_id_category_idx" ON "documents"("project_id", "category");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
