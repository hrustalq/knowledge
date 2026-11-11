-- Memo triage (#879, phase 2): what a model suggested for a memo before it is
-- analysed, the tags it ends up with, and where a type's memos go. Nullable
-- columns and columns with a default only, so the previous release is
-- unaffected: it never reads them, and a memo it writes gets the defaults.
ALTER TABLE "memos" ADD COLUMN "tags" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "memos" ADD COLUMN "triage" JSONB;
ALTER TABLE "memos" ADD COLUMN "triaged_at" TIMESTAMPTZ;

ALTER TABLE "memo_types" ADD COLUMN "project_id" UUID;
ALTER TABLE "memo_types" ADD COLUMN "auto" BOOLEAN NOT NULL DEFAULT false;
