-- Share links (docs/features/43, issue #77 phase 1). Expand-only: two new
-- tables and nothing altered, so the previous image runs against this schema
-- unchanged and a code rollback needs no database step. An empty
-- publishing_settings table means every workspace keeps sharing off.

-- CreateTable
CREATE TABLE "share_links" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "include_subtree" BOOLEAN NOT NULL DEFAULT false,
    "token_hash" TEXT NOT NULL,
    "token_cipher" TEXT,
    "password_hash" TEXT,
    "expires_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishing_settings" (
    "workspace_id" UUID NOT NULL,
    "allow_share_links" BOOLEAN,
    "allow_passwordless_shares" BOOLEAN,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "publishing_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_hash_key" ON "share_links"("token_hash");

-- CreateIndex
CREATE INDEX "share_links_document_id_idx" ON "share_links"("document_id");

-- CreateIndex
CREATE INDEX "share_links_workspace_id_created_at_idx" ON "share_links"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

