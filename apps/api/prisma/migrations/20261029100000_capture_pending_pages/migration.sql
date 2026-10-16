-- Agent-session memory, phase 2 (#73): a page that exists only as a merge
-- request (Option A) is hidden from every list until that merge request
-- merges. Additive — one nullable column — so the previous release ignores it
-- and a rollback is safe; the previous release would show the hidden stubs
-- again, empty, as it did before this column existed.

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "pending_merge_request_id" UUID;

-- Backfill: chat saves (#71) already made head-less pages this way, unhidden.
-- Those whose merge request has not merged become hidden stubs like a capture's.
UPDATE "documents" d
   SET "pending_merge_request_id" = cc."merge_request_id"
  FROM "chat_captures" cc
  JOIN "merge_requests" mr ON mr."id" = cc."merge_request_id"
 WHERE d."id" = cc."document_id"
   AND mr."status" <> 'merged';

-- Backfill merge request provenance (the column shipped in phase 1 with every
-- row 'manual'). An agent finding's merge request is recorded in the run's
-- findings array; a chat save's on its chat_captures row.
UPDATE "merge_requests" mr
   SET "provenance" = 'agent'
 WHERE mr."provenance" = 'manual'
   AND EXISTS (
     SELECT 1
       FROM "agent_runs" r, jsonb_array_elements(CASE WHEN jsonb_typeof(r."findings") = 'array' THEN r."findings" ELSE '[]'::jsonb END) f
      WHERE f->>'mergeRequestId' = mr."id"::text
   );

UPDATE "merge_requests" mr
   SET "provenance" = 'captured'
 WHERE mr."provenance" = 'manual'
   AND EXISTS (SELECT 1 FROM "chat_captures" cc WHERE cc."merge_request_id" = mr."id");
