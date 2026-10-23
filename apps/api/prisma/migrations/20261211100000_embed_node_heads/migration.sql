-- CreateTable
CREATE TABLE "embed_node_heads" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'figma',
    "file_key" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "current_version" TEXT NOT NULL,
    "current_hash" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embed_node_heads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "embed_node_heads_workspace_id_provider_file_key_node_id_key" ON "embed_node_heads"("workspace_id", "provider", "file_key", "node_id");

