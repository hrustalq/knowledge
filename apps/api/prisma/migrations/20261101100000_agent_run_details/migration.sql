-- Component pages, phase 4 (#236): what a run found that is not a finding — the
-- drift check's affected usages, which the pull request comment lists.
-- Additive and nullable, so the previous release ignores it and a rollback is safe.
ALTER TABLE "agent_runs" ADD COLUMN "details" JSONB;
