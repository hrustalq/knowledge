-- #927: attribute agent runs and model usage to a project. Nullable; a row
-- that names no single project stays null (unattributed), never guessed.
ALTER TABLE "agent_runs" ADD COLUMN "project_id" UUID;
ALTER TABLE "ai_usage" ADD COLUMN "project_id" UUID;

-- Backfill, the SQL twin of `projectOfRun` (apps/api/src/ai/run-project.ts):
-- a run about one page takes that page's project ...
UPDATE "agent_runs" r
   SET "project_id" = d."project_id"
  FROM "documents" d
 WHERE d."workspace_id" = r."workspace_id"
   AND d."id"::text = COALESCE(
         CASE WHEN r."subject_key" LIKE 'doc:%' THEN substr(r."subject_key", 5) END,
         r."input" ->> 'apiSpecDocumentId',
         r."input" -> 'apiTestSuite' ->> 'documentId',
         r."input" -> 'apiFixtureRanking' ->> 'documentId',
         CASE WHEN jsonb_typeof(r."input" -> 'documentIds') = 'array'
               AND jsonb_array_length(r."input" -> 'documentIds') = 1
              THEN r."input" -> 'documentIds' ->> 0 END);

-- ... one about a merge request or a reported issue, its page's ...
UPDATE "agent_runs" r
   SET "project_id" = d."project_id"
  FROM "merge_requests" m JOIN "documents" d ON d."id" = m."document_id"
 WHERE r."project_id" IS NULL AND r."subject_key" LIKE 'mr:%'
   AND m."id"::text = substr(r."subject_key", 4) AND d."workspace_id" = r."workspace_id";

UPDATE "agent_runs" r
   SET "project_id" = d."project_id"
  FROM "knowledge_issues" i JOIN "documents" d ON d."id" = i."document_id"
 WHERE r."project_id" IS NULL
   AND i."id"::text = COALESCE(r."input" ->> 'issueId', CASE WHEN r."subject_key" LIKE 'issue:%' THEN substr(r."subject_key", 7) END)
   AND i."workspace_id" = r."workspace_id";

-- ... one about a memo or a connector, theirs.
UPDATE "agent_runs" r
   SET "project_id" = m."project_id"
  FROM "memos" m
 WHERE r."project_id" IS NULL AND m."id"::text = r."input" -> 'memo' ->> 'memoId' AND m."workspace_id" = r."workspace_id";

UPDATE "agent_runs" r
   SET "project_id" = c."project_id"
  FROM "connectors" c
 WHERE r."project_id" IS NULL
   AND c."id"::text = COALESCE(r."input" ->> 'connectorId', CASE WHEN r."subject_key" LIKE 'connector:%' THEN substr(r."subject_key", 11) END)
   AND c."workspace_id" = r."workspace_id";

-- Usage follows its run, else the page its assistant thread is on.
UPDATE "ai_usage" u
   SET "project_id" = r."project_id"
  FROM "agent_runs" r
 WHERE u."agent_run_id" = r."id" AND r."project_id" IS NOT NULL;

UPDATE "ai_usage" u
   SET "project_id" = d."project_id"
  FROM "assistant_threads" t JOIN "documents" d ON d."id" = t."document_id"
 WHERE u."project_id" IS NULL AND u."thread_id" = t."id";
