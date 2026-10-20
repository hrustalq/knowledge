-- #80 phase 1: shared drafts. A new table only, so it survives a code rollback:
-- the previous image never reads it.
-- CreateTable
CREATE TABLE "collab_drafts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "base_revision_id" UUID,
    "state" BYTEA NOT NULL,
    "state_bytes" INTEGER NOT NULL,
    "published_state_vector" BYTEA,
    "schema_version" TEXT NOT NULL,
    "contributors" JSONB NOT NULL DEFAULT '[]',
    "last_edited_by" UUID,
    "last_checkpoint_at" TIMESTAMPTZ,
    "reset_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "collab_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collab_drafts_workspace_id_updated_at_idx" ON "collab_drafts"("workspace_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "collab_drafts_document_id_branch_id_key" ON "collab_drafts"("document_id", "branch_id");

-- AddForeignKey
ALTER TABLE "collab_drafts" ADD CONSTRAINT "collab_drafts_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collab_drafts" ADD CONSTRAINT "collab_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "document_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

