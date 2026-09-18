-- CreateTable
CREATE TABLE "entity_aliases" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "canonical_key" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entity_aliases_workspace_id_canonical_key_idx" ON "entity_aliases"("workspace_id", "canonical_key");

-- CreateIndex
CREATE UNIQUE INDEX "entity_aliases_workspace_id_alias_key" ON "entity_aliases"("workspace_id", "alias");
