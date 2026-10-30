-- #636 phase 4: the id line a pushed revision was served with. Nullable, no
-- backfill: every existing revision was web-written and keeps the canonical
-- line. The previous image never reads it.
ALTER TABLE "document_revisions" ADD COLUMN "id_line" JSONB;
