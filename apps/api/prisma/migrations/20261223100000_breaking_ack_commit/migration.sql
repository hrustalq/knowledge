-- #636 phase 1b-2a (docs/features/71): a merge request spans every page its
-- source branch changed, so the breaking-API acknowledgement pins the source
-- branch's head commit instead of one page's head revision.
--
-- Rollback: additive. The previous image never reads the column and still
-- finds `breaking_ack_revision_id`, which this release keeps writing.

ALTER TABLE "merge_requests" ADD COLUMN "breaking_ack_commit_id" UUID;

-- An acknowledgement that is current today stays current: it names the
-- source branch's latest commit.
UPDATE "merge_requests" mr
   SET "breaking_ack_commit_id" = (
         SELECT c.id FROM "project_commits" c
          WHERE c.project_id = d.project_id AND c.branch = sb.name
          ORDER BY c.seq DESC LIMIT 1)
  FROM "document_branches" sb, "documents" d
 WHERE sb.id = mr.source_branch_id
   AND d.id = mr.document_id
   AND mr.status = 'open'
   AND mr.breaking_ack_revision_id = sb.head_revision_id;
