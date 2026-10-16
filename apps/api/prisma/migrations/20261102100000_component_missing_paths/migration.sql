-- Component pages, phase 6 (#236): which declared paths no longer exist.
-- Additive — one new table and a defaulted column — so the previous release
-- ignores both and a rollback is safe. Nothing to backfill: both fill on each
-- codebase connector's next pull.

-- CreateTable
CREATE TABLE "code_files" (
    "connector_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "head_sha" TEXT,
    "path" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_files_pkey" PRIMARY KEY ("connector_id","path")
);

-- AddForeignKey
ALTER TABLE "code_files" ADD CONSTRAINT "code_files_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "component_declarations" ADD COLUMN "missing_paths" TEXT[] DEFAULT ARRAY[]::TEXT[];
