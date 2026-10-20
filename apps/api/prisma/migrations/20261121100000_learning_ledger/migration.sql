-- The learning-loop ledger (#305, phase 1): attribution columns on the rows
-- that already exist. Additive and nullable, no backfill: a row from before
-- this migration reads as unattributed. Outcomes are derived at read time
-- (outcomeFor), so there is no ledger table.

-- AlterTable
ALTER TABLE "answer_feedback" ADD COLUMN     "model" TEXT,
ADD COLUMN     "provider_id" UUID;

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "learning_ids" UUID[],
ADD COLUMN     "model" TEXT,
ADD COLUMN     "prompt_hash" TEXT,
ADD COLUMN     "provider_id" UUID;

-- AlterTable
ALTER TABLE "ai_usage" ADD COLUMN     "agent_key" TEXT,
ADD COLUMN     "agent_run_id" UUID;
