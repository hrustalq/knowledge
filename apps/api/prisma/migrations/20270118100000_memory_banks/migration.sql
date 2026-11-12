-- CreateTable
CREATE TABLE "memory_banks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" TEXT NOT NULL,
    "project_id" UUID,
    "name" TEXT NOT NULL,
    "mission" TEXT NOT NULL DEFAULT '',
    "disposition" JSONB NOT NULL DEFAULT '{"skepticism":3,"literalism":3,"empathy":3}',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_banks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "memory_banks_workspace_id_bank_id_key" ON "memory_banks"("workspace_id", "bank_id");

