-- CreateTable
CREATE TABLE "saved_filters" (
    "id" SERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "saved_filters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_filters_workspace_id_owner_id_idx" ON "saved_filters"("workspace_id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_filters_owner_id_workspace_id_name_key" ON "saved_filters"("owner_id", "workspace_id", "name");
