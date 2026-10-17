-- #74 phase 2: the style lint of a merge request's source head.
-- Additive only: two nullable columns on merge_request_threads, two on the
-- settings rows, and one new table. The previous release's image reads none of
-- them, so a code rollback needs no database step.
ALTER TABLE "merge_request_threads" ADD COLUMN "check_id" UUID,
ADD COLUMN "rule_id" TEXT;

CREATE INDEX "merge_request_threads_check_id_idx" ON "merge_request_threads"("check_id");

ALTER TABLE "projects" ADD COLUMN "lint_policy" TEXT;

ALTER TABLE "workspace_settings" ADD COLUMN "lint_policy" TEXT;

CREATE TABLE "merge_request_checks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "merge_request_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'lint',
    "head_revision_id" UUID NOT NULL,
    "styleguide_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "agent_run_id" UUID,
    "counts" JSONB,
    "published_at" TIMESTAMPTZ,
    "overridden_by" UUID,
    "overridden_at" TIMESTAMPTZ,
    "override_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "merge_request_checks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merge_request_checks_merge_request_id_kind_head_revision_id_key" ON "merge_request_checks"("merge_request_id", "kind", "head_revision_id");

CREATE INDEX "merge_request_checks_workspace_id_status_created_at_idx" ON "merge_request_checks"("workspace_id", "status", "created_at");

ALTER TABLE "merge_request_checks" ADD CONSTRAINT "merge_request_checks_merge_request_id_fkey" FOREIGN KEY ("merge_request_id") REFERENCES "merge_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
