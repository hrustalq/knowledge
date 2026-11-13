-- #1009 gaps: the updated_at of the content a file's recall chunks hold. Null on every existing
-- row, so the index sweeper rewrites each file's chunks once.
ALTER TABLE "memory_files" ADD COLUMN "indexed_at" TIMESTAMPTZ;
