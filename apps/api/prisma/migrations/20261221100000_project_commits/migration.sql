-- #636 phase 1a (docs/features/71): stored project commits, documents.slug,
-- and dedupe against the branch head instead of the whole branch.
--
-- Rollback: additive except the dropped unique index. The previous image
-- dedupes with findFirst, never through the constraint, so it runs on this
-- schema; commits it does not write stay missing from history.

-- A branch may return to content it once held (a revert): no longer unique.
DROP INDEX "document_revisions_document_id_branch_id_content_hash_key";
CREATE INDEX "document_revisions_document_id_branch_id_content_hash_idx" ON "document_revisions"("document_id", "branch_id", "content_hash");

-- Nullable on purpose: the previous image inserts documents without one.
ALTER TABLE "documents" ADD COLUMN "slug" TEXT;

CREATE TABLE "project_commits" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "branch" TEXT NOT NULL,
    "header" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_commits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_commit_parents" (
    "commit_id" UUID NOT NULL,
    "parent_commit_id" UUID NOT NULL,
    "parent_order" SMALLINT NOT NULL,

    CONSTRAINT "project_commit_parents_pkey" PRIMARY KEY ("commit_id","parent_order")
);

CREATE TABLE "project_commit_changes" (
    "commit_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "parent_document_id" UUID,
    "slug" TEXT NOT NULL,
    "removed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "project_commit_changes_pkey" PRIMARY KEY ("commit_id","document_id")
);

CREATE UNIQUE INDEX "project_commits_seq_key" ON "project_commits"("seq");
CREATE INDEX "project_commits_project_id_branch_seq_idx" ON "project_commits"("project_id", "branch", "seq");
CREATE INDEX "project_commits_workspace_id_idx" ON "project_commits"("workspace_id");
CREATE INDEX "project_commit_parents_parent_commit_id_idx" ON "project_commit_parents"("parent_commit_id");
CREATE INDEX "project_commit_changes_revision_id_idx" ON "project_commit_changes"("revision_id");

ALTER TABLE "project_commits" ADD CONSTRAINT "project_commits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_commit_parents" ADD CONSTRAINT "project_commit_parents_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "project_commits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_commit_parents" ADD CONSTRAINT "project_commit_parents_parent_commit_id_fkey" FOREIGN KEY ("parent_commit_id") REFERENCES "project_commits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_commit_changes" ADD CONSTRAINT "project_commit_changes_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "project_commits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill. Helpers live only for this migration.
-- ---------------------------------------------------------------------------

-- `slugFor` (apps/api/src/git/slug.ts) in SQL. A stored slug never flips, so
-- the two only have to agree on new titles; this one runs once.
CREATE FUNCTION kn_636_slug(title text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text;
BEGIN
  s := lower(normalize(title, NFC));
  s := regexp_replace(s, '\s+', '-', 'g');
  s := regexp_replace(s, '[/\\:*?"<>|[:cntrl:]]', '', 'g');
  s := regexp_replace(s, '-{2,}', '-', 'g');
  s := regexp_replace(s, '^[-.]+|[-.]+$', '', 'g');
  WHILE octet_length(s) > 80 LOOP s := left(s, char_length(s) - 1); END LOOP;
  s := regexp_replace(s, '^[-.]+|[-.]+$', '', 'g');
  IF s = '' THEN s := 'page'; END IF;
  IF s ~ '^(con|prn|aux|nul|com[0-9]|lpt[0-9])$' THEN s := s || '-page'; END IF;
  RETURN s;
END $$;

-- `ident` in ProjectCommitsService.header: a name and a noreply address,
-- never the person's own. GIT_NOREPLY_DOMAIN's default, since SQL cannot read env.
CREATE FUNCTION kn_636_ident(uid uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
           NULLIF(btrim(regexp_replace((SELECT display_name FROM users WHERE id = uid), '[<>\r\n]', '', 'g')), ''),
           'user-' || left(uid::text, 8))
         || ' <' || uid::text || '@users.noreply.knowledge>'
$$;

-- Slugs: unique among siblings case-folded; the page that came second gets
-- the first 8 hex of its id.
UPDATE "documents" d SET "slug" = s.slug
FROM (
  SELECT id,
         CASE WHEN row_number() OVER (PARTITION BY project_id, parent_id, lower(base) ORDER BY created_at, id) = 1
              THEN base ELSE base || '-' || left(id::text, 8) END AS slug
  FROM (SELECT id, project_id, parent_id, created_at, kn_636_slug(title) AS base FROM "documents") b
) s
WHERE s.id = d.id;

-- One commit per finalized revision, plus one per archived page, in time
-- order per project, at today's paths. A private draft page, or a page under
-- one, has no history until it is published (docs/features/71, finding 3).
CREATE TEMP TABLE kn_636_events AS
WITH pages AS (
  SELECT d.* FROM "documents" d
  WHERE NOT EXISTS (
    SELECT 1 FROM "documents" x
    WHERE x.draft_owner_id IS NOT NULL AND (x.id = d.id OR d.path LIKE '%/' || x.id::text || '/%')
  )
),
events AS (
  SELECT r.id AS revision_id, r.document_id, COALESCE(r.finalized_at, r.created_at) AS at, 0 AS kind,
         r.author_id, r.message, r.co_author_ids, COALESCE(b.name, p.default_branch) AS branch, false AS removed
  FROM "document_revisions" r
  JOIN pages p ON p.id = r.document_id
  LEFT JOIN "document_branches" b ON b.id = r.branch_id
  WHERE r.status <> 'draft'
  UNION ALL
  SELECT b.head_revision_id, p.id, p.archived_at, 1,
         COALESCE(p.archived_by, '00000000-0000-0000-0000-000000000000'::uuid), 'Archive ' || p.slug, NULL, p.default_branch, true
  FROM pages p
  JOIN "document_branches" b ON b.document_id = p.id AND b.name = p.default_branch
  WHERE p.archived_at IS NOT NULL AND b.head_revision_id IS NOT NULL
)
SELECT gen_random_uuid() AS commit_id,
       row_number() OVER (ORDER BY e.at, e.kind, e.revision_id) AS seq,
       e.*, p.workspace_id, p.project_id, p.parent_id, p.slug
FROM events e JOIN "documents" p ON p.id = e.document_id;

CREATE INDEX ON kn_636_events (revision_id, seq);

INSERT INTO "project_commits" ("id", "seq", "workspace_id", "project_id", "branch", "header", "created_at")
SELECT e.commit_id, e.seq, e.workspace_id, e.project_id, e.branch,
       convert_to(
         'author ' || kn_636_ident(e.author_id) || ' ' || floor(extract(epoch FROM e.at))::bigint || E' +0000\n'
         || 'committer ' || kn_636_ident(e.author_id) || ' ' || floor(extract(epoch FROM e.at))::bigint || E' +0000\n\n'
         || rtrim(COALESCE(NULLIF(btrim(e.message), ''), 'Update ' || e.slug), E' \t\r\n') || E'\n'
         || COALESCE(E'\n' || (
              SELECT string_agg('Co-authored-by: ' || kn_636_ident(c.id::uuid), E'\n' ORDER BY c.ord)
              FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.co_author_ids) = 'array' THEN e.co_author_ids ELSE '[]'::jsonb END)
                   WITH ORDINALITY AS c(id, ord)
              WHERE c.id::uuid <> e.author_id
            ) || E'\n', ''),
         'UTF8'),
       e.at
FROM kn_636_events e;

-- First parent: the previous commit on the same (project, branch name), or —
-- for a branch's first commit — the commit that wrote the revision it forked from.
INSERT INTO "project_commit_parents" ("commit_id", "parent_commit_id", "parent_order")
SELECT commit_id, first_parent, 1
FROM (
  SELECT e.commit_id,
         COALESCE(
           lag(e.commit_id) OVER (PARTITION BY e.project_id, e.branch ORDER BY e.seq),
           (SELECT f.commit_id FROM "revision_parents" rp JOIN kn_636_events f ON f.revision_id = rp.parent_revision_id
             WHERE rp.revision_id = e.revision_id AND rp.parent_order = 1 AND NOT e.removed
             ORDER BY f.seq LIMIT 1)
         ) AS first_parent
  FROM kn_636_events e
) x
WHERE first_parent IS NOT NULL;

-- Second parent: a merge-commit merge's source head, as `revision_parents`
-- records it. A squash keeps one parent, as in git.
INSERT INTO "project_commit_parents" ("commit_id", "parent_commit_id", "parent_order")
SELECT DISTINCT ON (e.commit_id) e.commit_id, src.commit_id, 2
FROM kn_636_events e
JOIN "merge_requests" mr ON mr.merged_revision_id = e.revision_id AND mr.strategy = 'merge-commit'
JOIN "revision_parents" rp ON rp.revision_id = e.revision_id
JOIN "document_revisions" sr ON sr.id = rp.parent_revision_id AND sr.branch_id = mr.source_branch_id
JOIN LATERAL (SELECT f.commit_id FROM kn_636_events f WHERE f.revision_id = sr.id ORDER BY f.seq LIMIT 1) src ON true
WHERE NOT e.removed
  AND EXISTS (SELECT 1 FROM "project_commit_parents" p WHERE p.commit_id = e.commit_id AND p.parent_order = 1 AND p.parent_commit_id <> src.commit_id)
ON CONFLICT DO NOTHING;

INSERT INTO "project_commit_changes" ("commit_id", "document_id", "revision_id", "parent_document_id", "slug", "removed")
SELECT commit_id, document_id, revision_id, parent_id, slug, removed FROM kn_636_events;

SELECT setval(pg_get_serial_sequence('project_commits', 'seq'), COALESCE((SELECT max(seq) FROM "project_commits"), 0) + 1, false);

DROP TABLE kn_636_events;
DROP FUNCTION kn_636_ident(uuid);
DROP FUNCTION kn_636_slug(text);
