-- #738: a merge wrote its revisions with the nil author, so provenance reported
-- no one for any page whose head came from a merge. The merger was recorded in
-- the revision's project commit, as the noreply address `ProjectCommitsService`
-- builds from the user id. A revision's first commit is the one that wrote it:
-- a later commit can list it again for a move or a rename, by someone else.
--
-- `encode(..., 'escape')`, not `convert_from`: a pushed commit's header is git's
-- own bytes and need not be UTF-8. Only nil-author rows change, so this is safe
-- to run against the previous image and survives a code rollback. Commits older
-- than #636, or written by the dev principal, name no one and stay as they are.
WITH merger AS (
  SELECT DISTINCT ON (ch.revision_id)
    ch.revision_id,
    substring(encode(c.header, 'escape') FROM '^author [^\n]*<([0-9a-f-]{36})@users\.noreply\.') AS user_id
  FROM project_commit_changes ch
  JOIN project_commits c ON c.id = ch.commit_id
  JOIN document_revisions r ON r.id = ch.revision_id
  WHERE r.author_id = '00000000-0000-0000-0000-000000000000'
  ORDER BY ch.revision_id, c.seq
)
UPDATE document_revisions r
SET author_id = merger.user_id::uuid
FROM merger
WHERE r.id = merger.revision_id
  AND merger.user_id IS NOT NULL;
