-- Backfill before the constraint (the CLAUDE.md rule for a NOT NULL column on a
-- populated table). A workflow run's model calls bill `created_by` into
-- `ai_usage.user_id @db.Uuid`; a null was billed as the literal 'workflow',
-- whose insert failed and was swallowed, so triggered spend never appeared.

-- 1. A triggered run belongs to whoever authored the definition and turned
--    auto-start on. That is the identity it should have been running as.
UPDATE "workflow_runs" AS r
SET "created_by" = d."created_by"
FROM "workflow_definitions" AS d
WHERE r."definition_id" = d."id"
  AND r."created_by" IS NULL
  AND d."created_by" IS NOT NULL;

-- 2. An ownerless run still in flight cannot be given an owner retroactively,
--    and must not resume under ambient authority. Cancel it — the processor
--    already skips nodes of a run that is not active, so the queued jobs drain
--    harmlessly and a person can restart it deliberately.
UPDATE "workflow_runs"
SET "status"      = 'cancelled',
    "error"       = 'Cancelled: this run had no owner to execute as (docs/features/17).',
    "finished_at" = NOW()
WHERE "created_by" IS NULL
  AND "status" NOT IN ('completed', 'cancelled', 'failed');

-- 3. What is left is historical and is never re-processed, so the dev/MCP stub
--    is inert here — it only ever grants authority through the processor, which
--    will not touch a terminal run.
UPDATE "workflow_runs"
SET "created_by" = '00000000-0000-0000-0000-000000000000'
WHERE "created_by" IS NULL;

-- AlterTable
ALTER TABLE "workflow_runs" ALTER COLUMN "created_by" SET NOT NULL;
