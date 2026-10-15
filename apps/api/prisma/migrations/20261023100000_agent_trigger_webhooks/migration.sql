-- Signed webhooks and comment mentions as agent triggers (#70, phase 3).
-- Nullable columns and a wider CHECK only: nothing is backfilled, and the
-- previous release neither reads nor writes any of it, so a rollback by retag
-- leaves the database valid (expand/contract).

-- AES-256-GCM envelope (ai/secret-box.ts); only a 'webhook' trigger has one.
ALTER TABLE "agent_triggers" ADD COLUMN "webhook_secret" TEXT;

ALTER TABLE "agent_triggers" DROP CONSTRAINT "agent_triggers_event_check";
ALTER TABLE "agent_triggers"
  ADD CONSTRAINT "agent_triggers_event_check"
    CHECK ("event" IN ('page.merged', 'page.indexed', 'merge-request.opened', 'connector.synced', 'webhook', 'comment.mention'));

-- The run a pending agent reply is waiting on: a mention of an agent with a
-- comment.mention trigger answers with its run's result, not a chat turn.
-- No FK, like every other agent_runs reference.
ALTER TABLE "document_comments" ADD COLUMN "agent_run_id" UUID;
ALTER TABLE "merge_request_comments" ADD COLUMN "agent_run_id" UUID;

CREATE INDEX "document_comments_agent_run_id_idx" ON "document_comments"("agent_run_id");
CREATE INDEX "merge_request_comments_agent_run_id_idx" ON "merge_request_comments"("agent_run_id");
