-- #479: deleting a workspace tombstones it; WorkspaceTeardownSweeper removes
-- everything it owns and then the row itself. Nullable, no backfill: every
-- existing workspace is live. Additive, so it survives a rollback.
ALTER TABLE "workspaces" ADD COLUMN "deleted_at" TIMESTAMPTZ;
