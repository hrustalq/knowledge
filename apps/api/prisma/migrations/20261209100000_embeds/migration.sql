-- CreateTable
CREATE TABLE "embed_files" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'figma',
    "file_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "connector_id" UUID NOT NULL,
    "project_id" TEXT NOT NULL,
    "team_id" TEXT,
    "checked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embed_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embed_nodes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'figma',
    "file_key" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "name" TEXT,
    "text" TEXT,
    "subtree_hash" TEXT,
    "snapshot_key" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "error" TEXT,
    "retry_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "embed_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revision_embeds" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "group_index" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "provider" TEXT,
    "file_key" TEXT,
    "node_id" TEXT,
    "version" TEXT,
    "caption" TEXT NOT NULL DEFAULT '',
    "warning" TEXT,

    CONSTRAINT "revision_embeds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "embed_files_connector_id_idx" ON "embed_files"("connector_id");

-- CreateIndex
CREATE UNIQUE INDEX "embed_files_workspace_id_provider_file_key_key" ON "embed_files"("workspace_id", "provider", "file_key");

-- CreateIndex
CREATE UNIQUE INDEX "embed_nodes_workspace_id_provider_file_key_node_id_version_key" ON "embed_nodes"("workspace_id", "provider", "file_key", "node_id", "version");

-- CreateIndex
CREATE INDEX "revision_embeds_document_id_file_key_node_id_version_idx" ON "revision_embeds"("document_id", "file_key", "node_id", "version");

-- CreateIndex
CREATE INDEX "revision_embeds_workspace_id_file_key_idx" ON "revision_embeds"("workspace_id", "file_key");

-- CreateIndex
CREATE UNIQUE INDEX "revision_embeds_revision_id_group_index_position_key" ON "revision_embeds"("revision_id", "group_index", "position");

