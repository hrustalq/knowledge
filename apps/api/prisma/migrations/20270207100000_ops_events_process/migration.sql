-- #1240: which entrypoint wrote an ops event, and a time index for the admin
-- errors list and the retention sweep. Additive: the previous image neither
-- writes nor reads the column, so this survives a code rollback.
ALTER TABLE "ops_events" ADD COLUMN "process" TEXT;

CREATE INDEX "ops_events_created_at_idx" ON "ops_events"("created_at");
