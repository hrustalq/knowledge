-- Feature 08 nesting: a materialized ancestor path, so hierarchy stops being a
-- walk.
--
-- Hand-edited after `prisma migrate dev --create-only`: path/depth/position are
-- NOT NULL on a populated table (468 rows here), so they are added nullable,
-- backfilled, and only then constrained. Same shape as
-- 20260907160044_projects_layer.

ALTER TABLE "documents" ADD COLUMN "path" TEXT;
ALTER TABLE "documents" ADD COLUMN "depth" INTEGER;
ALTER TABLE "documents" ADD COLUMN "position" INTEGER;

-- Root-down. A recursive CTE belongs here and nowhere else: the backfill runs
-- once, inside the migration, where there is no application code to walk a tree
-- with.
WITH RECURSIVE tree AS (
  SELECT d."id", '/' || d."id"::text || '/' AS path, 0 AS depth
    FROM "documents" d
   -- "Missing parent means root" is the tolerance the read path already has
   -- (documents.service.ts treeLevel). There is no FK on parent_id by design,
   -- so a row pointing at a deleted page must seed here or its whole subtree
   -- would get no path at all.
   WHERE d."parent_id" IS NULL
      OR NOT EXISTS (SELECT 1 FROM "documents" p WHERE p."id" = d."parent_id")
  UNION ALL
  SELECT c."id", t.path || c."id"::text || '/', t.depth + 1
    FROM "documents" c
    JOIN tree t ON c."parent_id" = t."id"
   -- A cycle predating the cycle check must terminate, not spin.
   WHERE t.depth < 64
)
UPDATE "documents" d
   SET "path" = t.path, "depth" = t.depth
  FROM tree t
 WHERE d."id" = t."id";

-- Anything a cycle left unreached re-roots, which is what the read path does
-- with it anyway. NULL is the one state this column may never hold.
UPDATE "documents"
   SET "path" = '/' || "id"::text || '/', "depth" = 0
 WHERE "path" IS NULL;

-- position from the order the tree is drawn in TODAY (orderBy title asc), so
-- the migration is behaviour-preserving on screen.
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "project_id", COALESCE("parent_id"::text, '')
           ORDER BY "title" ASC, "id" ASC
         ) - 1 AS pos
    FROM "documents"
)
UPDATE "documents" d SET "position" = r.pos FROM ranked r WHERE d."id" = r."id";

ALTER TABLE "documents" ALTER COLUMN "path" SET NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "depth" SET NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "position" SET NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "position" SET DEFAULT 0;

CREATE INDEX "documents_workspace_id_path_idx" ON "documents"("workspace_id", "path");
CREATE INDEX "documents_parent_id_position_idx" ON "documents"("parent_id", "position");
