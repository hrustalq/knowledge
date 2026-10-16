-- Component pages, phase 1 (#236): the reverse-import index of a code
-- connector's head. Additive — one new table, written only by the new pull
-- step — so the previous release ignores it and a rollback is safe. It starts
-- empty and fills on each codebase connector's next pull.

-- CreateTable
CREATE TABLE "code_imports" (
    "connector_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "head_sha" TEXT,
    "importer_path" TEXT NOT NULL,
    "imported_path" TEXT NOT NULL,
    "names" TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_imports_pkey" PRIMARY KEY ("connector_id","importer_path","imported_path")
);

-- CreateIndex
CREATE INDEX "code_imports_connector_id_imported_path_idx" ON "code_imports"("connector_id", "imported_path");

-- AddForeignKey
ALTER TABLE "code_imports" ADD CONSTRAINT "code_imports_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

