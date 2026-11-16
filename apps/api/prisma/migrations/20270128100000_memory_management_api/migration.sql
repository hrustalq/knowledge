CREATE TABLE "memory_bank_aliases" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "bank_id" UUID NOT NULL,
  "alias" TEXT NOT NULL,
  "primary" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_bank_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_bank_aliases_workspace_id_alias_key" ON "memory_bank_aliases"("workspace_id", "alias");
CREATE UNIQUE INDEX "memory_bank_aliases_bank_id_alias_key" ON "memory_bank_aliases"("bank_id", "alias");
CREATE INDEX "memory_bank_aliases_workspace_id_idx" ON "memory_bank_aliases"("workspace_id");
CREATE UNIQUE INDEX "memory_bank_aliases_one_primary" ON "memory_bank_aliases"("bank_id") WHERE "primary";
ALTER TABLE "memory_bank_aliases" ADD CONSTRAINT "memory_bank_aliases_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "memory_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_transfer_archives" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "bank_id" UUID NOT NULL,
  "operation_id" UUID NOT NULL,
  "filename" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_transfer_archives_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_transfer_archives_operation_id_key" ON "memory_transfer_archives"("operation_id");
CREATE INDEX "memory_transfer_archives_workspace_id_idx" ON "memory_transfer_archives"("workspace_id");
ALTER TABLE "memory_transfer_archives" ADD CONSTRAINT "memory_transfer_archives_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "memory_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_operations" ADD COLUMN "result" JSONB;
ALTER TABLE "memory_units" ADD COLUMN "position" SERIAL;
CREATE INDEX "memory_units_bank_id_document_id_position_idx" ON "memory_units"("bank_id", "document_id", "position");
