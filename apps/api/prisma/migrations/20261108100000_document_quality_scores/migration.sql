-- #74 phase 4: per-page quality scores written by the auditor agent.
-- Additive only: one nullable settings column and one new table. The previous
-- release's image reads neither, so a code rollback needs no database step.
ALTER TABLE "ai_settings" ADD COLUMN "quality_audit_days" INTEGER;

CREATE TABLE "document_quality_scores" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "agent_run_id" UUID,
    "rubric_version" INTEGER NOT NULL,
    "styleguide_hash" TEXT,
    "overall" INTEGER NOT NULL,
    "dimensions" JSONB NOT NULL,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "duplicates" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_quality_scores_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "document_quality_scores_workspace_id_created_at_idx" ON "document_quality_scores"("workspace_id", "created_at");

CREATE INDEX "document_quality_scores_project_id_created_at_idx" ON "document_quality_scores"("project_id", "created_at");

CREATE INDEX "document_quality_scores_document_id_created_at_idx" ON "document_quality_scores"("document_id", "created_at");
