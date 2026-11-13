-- AlterTable
ALTER TABLE "memory_units" ADD COLUMN     "operation_id" UUID;

-- CreateTable
CREATE TABLE "memory_operations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'retain',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "items_count" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_operations_bank_id_created_at_idx" ON "memory_operations"("bank_id", "created_at");

-- CreateIndex
CREATE INDEX "memory_operations_status_updated_at_idx" ON "memory_operations"("status", "updated_at");

-- CreateIndex
CREATE INDEX "memory_units_operation_id_idx" ON "memory_units"("operation_id");

-- AddForeignKey
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "memory_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

