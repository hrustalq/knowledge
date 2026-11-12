-- #923: tracker handoff rules per project. Null inherits the workspace's rule;
-- an explicit 'off' opts the project out.
ALTER TABLE "projects"
  ADD COLUMN "work_item_issues" TEXT,
  ADD COLUMN "work_item_conflicts" TEXT,
  ADD COLUMN "work_item_verification" TEXT;
