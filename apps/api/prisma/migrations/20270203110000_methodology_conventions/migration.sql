-- Methodologies (#1121, phase 2): styleguides and glossary terms a methodology
-- owns. Nullable; null reproduces the previous behaviour.
ALTER TABLE "ai_skills" ADD COLUMN "blueprint_id" UUID;
ALTER TABLE "glossary_terms" ADD COLUMN "blueprint_id" UUID;

CREATE INDEX "glossary_terms_workspace_id_blueprint_id_idx" ON "glossary_terms"("workspace_id", "blueprint_id");

-- One styleguide per scope, where a scope is now (workspace, project,
-- methodology): a methodology's styleguide has no project, and must not take
-- the workspace's slot. Every existing row has blueprint_id null, so the new
-- index accepts exactly the rows the old one did.
DROP INDEX "ai_skills_one_styleguide_per_scope";
CREATE UNIQUE INDEX "ai_skills_one_styleguide_per_scope" ON "ai_skills"(
  "workspace_id",
  COALESCE("project_id", '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE("blueprint_id", '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE "kind" = 'styleguide';
