-- #1195: a ticket-context answer's size in tokens. Null for every other search;
-- additive and nullable, so no backfill and nothing for a rollback to undo.
ALTER TABLE "search_queries" ADD COLUMN "result_tokens" INTEGER;
