-- #528: BM25 rows gain a `heading` field (page title + section headings).
-- Rows written before it have none, so mark every indexed revision for the
-- fulltext re-mirror (StaleSweeper.repairFulltext), which rewrites them from
-- the graph's chunks with nothing re-embedded. Default-branch heads sort first,
-- so live search is covered before history. A revision already marked keeps
-- its earlier stamp. Millisecond precision on purpose: the sweeper clears a
-- stamp only while it equals the JS Date it read, and a microsecond `now()`
-- never would, so the same batch would be re-mirrored forever. Data only: the
-- previous release's image re-mirrors the same rows without the field, which
-- is harmless.
UPDATE "document_revisions" r
SET "fulltext_stale_at" = date_trunc('milliseconds', now()) - CASE
  WHEN EXISTS (
    SELECT 1
    FROM "document_branches" b
    JOIN "documents" d ON d."id" = b."document_id"
    WHERE b."head_revision_id" = r."id" AND b."name" = d."default_branch"
  ) THEN interval '1 day'
  ELSE interval '0'
END
WHERE r."status" = 'indexed' AND r."fulltext_stale_at" IS NULL;
