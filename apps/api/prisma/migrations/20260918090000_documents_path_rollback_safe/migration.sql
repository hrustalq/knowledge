-- Make the previous release's image able to write to this schema.
--
-- docs/versioning.md: "Every migration must be runnable by the previous
-- release's image." The migration before this one added path/depth NOT NULL
-- with no default, so a rollback to v0.8.0 — whose createDocument does not know
-- the columns exist — would have failed every page creation with a not-null
-- violation. That is the "release you cannot undo" the rule exists to prevent.
--
-- The sentinel is deliberately NOT '' or '/'. Both are prefixes of every real
-- path, so a subtree query against such a row would match the whole workspace.
-- '/pending/' is a prefix of nothing real, so a row written by an old image is
-- inert rather than dangerous, and is trivial to find and repair afterwards:
--
--   WITH RECURSIVE tree AS (...)  -- the CTE from the previous migration
--   UPDATE documents SET path = tree.path, depth = tree.depth ... ;
--
-- which is exactly what the Operations note in CHANGELOG.md says to run.
ALTER TABLE "documents" ALTER COLUMN "path" SET DEFAULT '/pending/';
ALTER TABLE "documents" ALTER COLUMN "depth" SET DEFAULT 0;
