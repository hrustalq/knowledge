-- Connections (#564): one account's access to one upstream system, shared by
-- compatible connectors. Expand only: connectors.credential stays populated and
-- read as a fallback for one release, so the previous image keeps syncing.
-- Existing connectors get their connection from the API boot step
-- (ConnectionsBackfill), which derives the provider with the same rule new
-- connections use and merges equal tokens — neither is expressible in SQL.

-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "connection_id" UUID;

-- CreateTable
CREATE TABLE "connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "site" TEXT,
    "account_id" TEXT,
    "account_label" TEXT,
    "account_avatar_url" TEXT,
    "credential" TEXT,
    "credential_hint" TEXT,
    "external_ref" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connections_workspace_id_provider_method_external_ref_key" ON "connections"("workspace_id", "provider", "method", "external_ref");

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

