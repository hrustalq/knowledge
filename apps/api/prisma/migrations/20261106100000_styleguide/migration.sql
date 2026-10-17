-- #74 phase 1: a styleguide is an ai_skills row with kind = 'styleguide'.
-- `kind` is NOT NULL with a default, so every existing row reads 'skill' and no
-- backfill is needed; `project_id` and `rules` are nullable. The previous
-- release's image never reads them, and it never sees a styleguide row as a
-- skill only because none exists before this release's image writes one — so a
-- rollback after styleguides were created should delete them first
-- (DELETE FROM ai_skills WHERE kind = 'styleguide').
ALTER TABLE "ai_skills" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'skill',
ADD COLUMN "project_id" UUID,
ADD COLUMN "rules" JSONB;

CREATE INDEX "ai_skills_workspace_id_kind_project_id_idx" ON "ai_skills"("workspace_id", "kind", "project_id");

-- At most one styleguide per scope: per workspace (project_id NULL) and per
-- project. NULLs are distinct in a plain unique index, hence the COALESCE; the
-- predicate keeps skills out of it. Partial, so not expressible in Prisma — the
-- service's guarded write is the rule, this is the backstop.
CREATE UNIQUE INDEX "ai_skills_one_styleguide_per_scope" ON "ai_skills"("workspace_id", COALESCE("project_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "kind" = 'styleguide';
