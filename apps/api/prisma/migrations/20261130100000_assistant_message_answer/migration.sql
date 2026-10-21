-- Question flows (#425): the structured answer a user turn gave to one flow step.
-- Nullable and additive: the previous release ignores the column, so this survives a rollback.
ALTER TABLE "assistant_messages" ADD COLUMN "answer" JSONB;
