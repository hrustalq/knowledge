-- #78 phase 6: the breaking-change merge gate. Nullable columns, no backfill:
-- an empty policy is `warn`, which never refuses a merge, and no merge request
-- has an acknowledgement yet. The previous release's image never reads them,
-- so a rollback leaves them inert.
ALTER TABLE "workspace_settings" ADD COLUMN "api_breaking_change_policy" TEXT;

ALTER TABLE "merge_requests" ADD COLUMN "breaking_ack_by" UUID,
ADD COLUMN "breaking_ack_at" TIMESTAMPTZ,
ADD COLUMN "breaking_ack_revision_id" UUID;
