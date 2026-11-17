-- Methodologies (#1121, phase 1): a project's live methodology link, and rows
-- a methodology owns. All nullable; null reproduces the previous behaviour.
ALTER TABLE "projects" ADD COLUMN "blueprint_id" UUID;
ALTER TABLE "page_templates" ADD COLUMN "blueprint_id" UUID;
ALTER TABLE "workflow_definitions" ADD COLUMN "blueprint_id" UUID;

CREATE INDEX "page_templates_workspace_id_blueprint_id_idx" ON "page_templates"("workspace_id", "blueprint_id");
CREATE INDEX "workflow_definitions_workspace_id_blueprint_id_idx" ON "workflow_definitions"("workspace_id", "blueprint_id");
