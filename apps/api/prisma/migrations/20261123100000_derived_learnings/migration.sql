-- Derived learnings (#305, phase 2): what the learner needs on the rows that
-- already exist. Additive and nullable, no backfill: a learning a person wrote
-- has no evidence, and nothing has been checked for archiving yet.

-- AlterTable
ALTER TABLE "agent_learnings" ADD COLUMN     "archive_check" JSONB,
ADD COLUMN     "archive_proposed_at" TIMESTAMPTZ,
ADD COLUMN     "evidence" JSONB;

-- Hand-written: Prisma cannot express a CHECK. The learner's rows are
-- `derived` (AGENT_LEARNING_SOURCES); widening the list is expand-only, and a
-- previous release simply never writes the new value.
ALTER TABLE "agent_learnings" DROP CONSTRAINT "agent_learnings_source_kind_check",
  ADD CONSTRAINT "agent_learnings_source_kind_check"
    CHECK ("source_kind" IN ('document-thread', 'mr-thread', 'finding', 'manual', 'derived'));
