-- The subscriptions list is now cursor-paged (newest first) rather than a flat
-- `take: 500`, so the column it sorts by joins the index the scan already used.
-- Index only: no data moves, and the previous release runs against it unchanged.
DROP INDEX "notification_subscriptions_workspace_id_user_id_idx";

CREATE INDEX "notification_subscriptions_workspace_id_user_id_created_at_idx" ON "notification_subscriptions"("workspace_id", "user_id", "created_at");
