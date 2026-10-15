-- Page and project restrictions (#76, phase 2). Additive only: one new table and
-- columns whose defaults reproduce today's behaviour exactly — nothing is
-- restricted, so `restricted_by` is empty everywhere and no backfill is needed.
-- The previous release's image never reads these columns and inserts rows that
-- take the defaults, so it runs against this schema unchanged.

-- CreateTable
CREATE TABLE "access_grants" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "level" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "connector_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_grants_resource_type_resource_id_subject_type_subjec_key" ON "access_grants"("resource_type", "resource_id", "subject_type", "subject_id", "origin");

-- CreateIndex
CREATE INDEX "access_grants_workspace_id_subject_type_subject_id_idx" ON "access_grants"("workspace_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "access_grants_resource_id_idx" ON "access_grants"("resource_id");

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "restricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "restricted_by" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "acl_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "acl_stamped_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "restricted" BOOLEAN NOT NULL DEFAULT false;

-- The visibility predicate is `restricted_by && <denied nodes>`; GIN serves the
-- overlap operator. Not expressible in the Prisma schema.
CREATE INDEX "documents_restricted_by_gin" ON "documents" USING gin ("restricted_by");
