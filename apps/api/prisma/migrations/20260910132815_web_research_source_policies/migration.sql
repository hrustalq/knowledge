-- AlterTable
ALTER TABLE "ai_settings" ADD COLUMN     "web_access_mode" TEXT;

-- CreateTable
CREATE TABLE "source_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "pattern" TEXT NOT NULL,
    "allow" BOOLEAN NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_policies_workspace_id_idx" ON "source_policies"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_policies_workspace_id_pattern_key" ON "source_policies"("workspace_id", "pattern");
