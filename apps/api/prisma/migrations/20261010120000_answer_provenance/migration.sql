-- Issue #67 phase 1 (docs/features/38): answer provenance and the manual
-- verification stamp. Expand-only: every column is nullable or defaulted, so
-- the previous release's image runs against this schema unchanged.
ALTER TABLE "assistant_messages" ADD COLUMN "citations" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "assistant_messages" ADD COLUMN "confidence" JSONB;

ALTER TABLE "documents" ADD COLUMN "verified_at" TIMESTAMPTZ(3);
ALTER TABLE "documents" ADD COLUMN "verified_by" UUID;
ALTER TABLE "documents" ADD COLUMN "verified_revision_id" UUID;
