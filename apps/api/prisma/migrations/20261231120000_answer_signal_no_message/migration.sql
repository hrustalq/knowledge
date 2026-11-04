-- #754: a signal and a vote shared the unique key (message_id, created_by), so a
-- vote on a weak answer landed on the signal's row and kept its kind. Votes read
-- by kind, so it vanished on reload and could not be retracted. A signal now holds
-- no message id (its thread is enough), which leaves that key to votes.

-- A row holding a rating under a signal kind becomes two: the signal as it was, and the vote.
INSERT INTO "answer_feedback" (
  "id", "workspace_id", "kind", "surface", "query", "answer_excerpt", "thread_id", "message_id", "trace_id",
  "cited_document_ids", "confidence", "provider_id", "model", "created_by", "api_key_id", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(), "workspace_id", "kind", "surface", "query", "answer_excerpt", "thread_id", NULL, "trace_id",
  "cited_document_ids", "confidence", "provider_id", "model", "created_by", "api_key_id", "created_at", "updated_at"
FROM "answer_feedback"
WHERE "rating" IS NOT NULL AND "kind" <> 'vote';

UPDATE "answer_feedback" SET "kind" = 'vote' WHERE "rating" IS NOT NULL AND "kind" <> 'vote';

UPDATE "answer_feedback" SET "message_id" = NULL WHERE "kind" <> 'vote' AND "message_id" IS NOT NULL;
