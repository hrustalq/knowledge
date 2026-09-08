-- Editable comments: the author may rewrite what they posted.
--
-- Nullable rather than defaulted-to-created_at, so "never edited" and "edited
-- the instant it was posted" stay distinguishable — the UI only marks a comment
-- as edited when this is set.
ALTER TABLE "merge_request_comments" ADD COLUMN "updated_at" TIMESTAMPTZ;
ALTER TABLE "document_comments" ADD COLUMN "updated_at" TIMESTAMPTZ;

-- GitLab's Comment vs. Start thread. A plain comment is a remark; a thread is
-- a request that stays open until resolved. Defaulted true so every existing
-- row keeps behaving exactly as it does today.
ALTER TABLE "merge_request_threads" ADD COLUMN "resolvable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "document_threads" ADD COLUMN "resolvable" BOOLEAN NOT NULL DEFAULT true;
