-- #809: stale-run recovery counts its re-queues, so a run whose worker keeps
-- dying is failed instead of re-queued forever. Additive with a default:
-- the previous release's image ignores the column.
ALTER TABLE "connector_runs" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;
