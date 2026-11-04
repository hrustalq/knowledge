-- #771: a page created behind a merge request that was closed, and landed by a
-- later one, kept the closed request's id and stayed out of every list, search
-- and tree. A page with a default-branch head has content to list. A page whose
-- only merge request was closed has no such head and stays hidden.
UPDATE "documents" d
   SET "pending_merge_request_id" = NULL
  FROM "merge_requests" mr, "document_branches" b
 WHERE mr."id" = d."pending_merge_request_id"
   AND mr."status" = 'closed'
   AND b."document_id" = d."id"
   AND b."name" = d."default_branch"
   AND b."head_revision_id" IS NOT NULL;
