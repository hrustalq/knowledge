-- Chat harvest, phase 1 (#82): a chat capture is an agent-memory capture.
--
-- 1. knowledge_captures gains a server-set `origin` (nullable, additive).
-- 2. Every chat_captures row (💾 Save on a bot answer, #71) is copied into
--    knowledge_captures under its own id, with client 'chat', so the Captures
--    inbox shows it with the status it had.
-- 3. chat_captures is dropped.
--
-- NOT reversible under expand/contract: the previous release still writes
-- chat_captures, so after a rollback to it 💾 Save fails until this release is
-- rolled forward again. Everything else of the previous release runs.

-- AlterTable
ALTER TABLE "knowledge_captures" ADD COLUMN "origin" JSONB;

-- Page saves become `answer` captures, term saves `glossary` ones. A row the
-- old path left pending is failed: its continuation is long gone. A row with no
-- project anywhere (deleted page and term, a DM, a workspace with no project)
-- cannot be a capture, which always belongs to one, and goes with the table.
INSERT INTO "knowledge_captures" (
  "id", "workspace_id", "project_id", "kind", "status", "outcome", "title", "payload",
  "content_hash", "session", "origin", "similar", "target_document_id", "merge_request_id",
  "glossary_term_id", "created_by", "error", "attempts", "created_at", "updated_at"
)
SELECT
  cc."id",
  cc."workspace_id",
  COALESCE(d."project_id", gt."project_id", b."project_id", first_project."id"),
  CASE cc."kind" WHEN 'page' THEN 'answer' ELSE 'glossary' END,
  CASE cc."status" WHEN 'published' THEN 'proposed' ELSE 'failed' END,
  CASE WHEN cc."status" <> 'published' THEN NULL WHEN cc."kind" = 'page' THEN 'new-page' ELSE 'glossary' END,
  LEFT(COALESCE(cc."title", gt."term", 'Saved from chat'), 300),
  CASE cc."kind"
    WHEN 'page' THEN jsonb_build_object(
      'question', COALESCE(cc."title", ''),
      'answer', COALESCE(am."content", ''),
      'citedDocumentIds', COALESCE((
        SELECT jsonb_agg(DISTINCT s->>'documentId')
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(am."sources") = 'array' THEN am."sources" ELSE '[]'::jsonb END) s
         WHERE s ? 'documentId'
      ), '[]'::jsonb)
    )
    ELSE jsonb_build_object(
      'term', COALESCE(gt."term", cc."title", ''),
      'definition', COALESCE(gt."definition", ''),
      'aliases', COALESCE(gt."aliases", '[]'::jsonb)
    )
  END,
  -- Never matches a new capture's hash: a migrated row is history, not a dedupe target.
  encode(sha256(convert_to('chat_capture:' || cc."id"::text, 'UTF8')), 'hex'),
  '{"client":"chat"}'::jsonb,
  jsonb_build_object(
    'platform', ci."kind",
    'chatTitle', b."title",
    'from', to_jsonb(ca."created_at"),
    'to', to_jsonb(COALESCE(am."created_at", ca."updated_at"))
  ),
  '[]'::jsonb,
  cc."document_id",
  cc."merge_request_id",
  cc."glossary_term_id",
  cc."requested_by",
  CASE cc."status" WHEN 'pending' THEN 'pending when chat saves moved to agent memory' ELSE cc."error" END,
  0,
  cc."created_at",
  cc."updated_at"
FROM "chat_captures" cc
JOIN "chat_answers" ca ON ca."id" = cc."answer_id"
JOIN "chat_integrations" ci ON ci."id" = ca."integration_id"
LEFT JOIN "chat_channel_bindings" b ON b."integration_id" = ca."integration_id" AND b."external_chat_id" = ca."external_chat_id"
LEFT JOIN "assistant_messages" am ON am."id" = ca."assistant_message_id"
LEFT JOIN "documents" d ON d."id" = cc."document_id"
LEFT JOIN "glossary_terms" gt ON gt."id" = cc."glossary_term_id"
LEFT JOIN LATERAL (
  SELECT p."id" FROM "projects" p WHERE p."workspace_id" = cc."workspace_id" ORDER BY p."created_at" ASC LIMIT 1
) first_project ON TRUE
WHERE COALESCE(d."project_id", gt."project_id", b."project_id", first_project."id") IS NOT NULL;

-- The merge request finds its capture, so its provenance strip names the chat.
UPDATE "merge_requests" mr
   SET "capture_id" = kc."id"
  FROM "knowledge_captures" kc
 WHERE kc."merge_request_id" = mr."id"
   AND kc."session"->>'client' = 'chat'
   AND mr."capture_id" IS NULL;

-- DropTable
DROP TABLE "chat_captures";
