-- #636 phase 1b-1 (docs/features/71): project branches. Every page's branch
-- of one name in a project becomes one project branch.
--
-- Rollback: additive. `project_branch_id` stays nullable because the previous
-- image inserts branches without it, and the renamed legacy branches below are
-- ordinary names to it. Branches it creates meanwhile are filled in later by
-- `ProjectCommitsService.rehomeBranches` or the release that sets NOT NULL.

ALTER TABLE "document_branches" ADD COLUMN "project_branch_id" UUID;

CREATE TABLE "project_branches" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_branches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_branches_workspace_id_idx" ON "project_branches"("workspace_id");
CREATE UNIQUE INDEX "project_branches_project_id_name_key" ON "project_branches"("project_id", "name");
CREATE INDEX "document_branches_project_branch_id_idx" ON "document_branches"("project_branch_id");

ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_project_branch_id_fkey" FOREIGN KEY ("project_branch_id") REFERENCES "project_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "project_branches" ADD CONSTRAINT "project_branches_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- Page branches group by (project, name). A group that a merge request came
-- from is split instead, one project branch per page: phase 1b-2 derives an
-- open merge request's pages from its source project branch, so a legacy
-- merge request must not gain pages it never had. The earliest branch keeps
-- the name; the others get `-<first 8 hex of the page id>`. A page's default
-- branch is never renamed.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE kn_636b AS
WITH rows AS (
  SELECT b.id, b.name, b.created_at, d.workspace_id, d.project_id, d.id AS document_id,
         b.name = d.default_branch AS is_default
  FROM "document_branches" b JOIN "documents" d ON d.id = b.document_id
),
sourced AS (
  SELECT DISTINCT r.project_id, r.name
  FROM "merge_requests" m JOIN rows r ON r.id = m.source_branch_id
  WHERE NOT r.is_default
),
ranked AS (
  SELECT r.*,
         row_number() OVER (PARTITION BY r.project_id, r.name, r.is_default ORDER BY r.created_at, r.id) AS rank,
         EXISTS (SELECT 1 FROM sourced s WHERE s.project_id = r.project_id AND s.name = r.name) AS split
  FROM rows r
)
SELECT id, workspace_id, project_id, created_at, name AS old_name,
       CASE WHEN is_default OR NOT split OR rank = 1 THEN name
            ELSE name || '-' || left(document_id::text, 8) END AS new_name
FROM ranked;

INSERT INTO "project_branches" ("id", "workspace_id", "project_id", "name", "created_at")
SELECT gen_random_uuid(), workspace_id, project_id, new_name, min(created_at)
FROM kn_636b
GROUP BY workspace_id, project_id, new_name;

UPDATE "document_branches" b
SET "name" = k.new_name, "project_branch_id" = pb.id
FROM kn_636b k JOIN "project_branches" pb ON pb.project_id = k.project_id AND pb.name = k.new_name
WHERE b.id = k.id;

-- Phase 1a wrote commits on branch names. A renamed branch's commits follow
-- it, and every commit on a branch that lost or gained commits gets its
-- first parent again: the previous commit on that branch, or, for its first,
-- the commit that wrote the revision it forked from (as 1a's backfill).
UPDATE "project_commits" c
SET "branch" = k.new_name
FROM "project_commit_changes" ch
JOIN "document_revisions" r ON r.id = ch.revision_id
JOIN kn_636b k ON k.id = r.branch_id
WHERE ch.commit_id = c.id AND k.new_name <> k.old_name AND c.branch = k.old_name;

CREATE TEMP TABLE kn_636b_commits AS
SELECT c.id, c.seq, c.project_id, c.branch,
       (SELECT ch.revision_id FROM "project_commit_changes" ch WHERE ch.commit_id = c.id LIMIT 1) AS revision_id
FROM "project_commits" c
WHERE EXISTS (
  SELECT 1 FROM kn_636b k
  WHERE k.new_name <> k.old_name AND k.project_id = c.project_id AND c.branch IN (k.old_name, k.new_name)
);

DELETE FROM "project_commit_parents" p USING kn_636b_commits k WHERE p.commit_id = k.id AND p.parent_order = 1;

INSERT INTO "project_commit_parents" ("commit_id", "parent_commit_id", "parent_order")
SELECT id, first_parent, 1
FROM (
  SELECT k.id,
         COALESCE(
           lag(k.id) OVER (PARTITION BY k.project_id, k.branch ORDER BY k.seq),
           (SELECT ch.commit_id
              FROM "revision_parents" rp
              JOIN "project_commit_changes" ch ON ch.revision_id = rp.parent_revision_id
              JOIN "project_commits" f ON f.id = ch.commit_id
             WHERE rp.revision_id = k.revision_id AND rp.parent_order = 1 AND f.seq < k.seq
             ORDER BY f.seq LIMIT 1)
         ) AS first_parent
  FROM kn_636b_commits k
) x
WHERE first_parent IS NOT NULL;

DROP TABLE kn_636b_commits;
DROP TABLE kn_636b;
