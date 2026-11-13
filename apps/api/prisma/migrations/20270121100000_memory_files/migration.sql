-- The Anthropic memory tool's files (#1009). Additive: the previous release
-- ignores the table, so it survives a rollback. Directories are implied by
-- paths; recall reads the files through memory_units chunks.

-- CreateTable
CREATE TABLE "memory_files" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "memory_files_bank_id_path_key" ON "memory_files"("bank_id", "path");

-- AddForeignKey
ALTER TABLE "memory_files" ADD CONSTRAINT "memory_files_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "memory_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
