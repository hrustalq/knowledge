-- #901: deleting a project left its memos (and the memo settings naming it)
-- pointing at an id that no longer resolves. No screen lists such a memo, so
-- the owner chose to remove them. Their audio, if any, stays in the bucket as
-- unreferenced objects under workspaces/{ws}/memos/{id}/ — a migration cannot
-- reach object storage.
DELETE FROM "memos" m
WHERE NOT EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = m."project_id");

-- Null already means "auto-import off" / "the link's project" / "stays where it
-- arrived", which is what the project delete now writes too.
UPDATE "plaud_links" l SET "project_id" = NULL
WHERE l."project_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = l."project_id");

UPDATE "plaud_imports" i SET "project_id" = NULL
WHERE i."project_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = i."project_id");

UPDATE "memo_types" t SET "project_id" = NULL
WHERE t."project_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = t."project_id");
