-- Repo guidance import (#70, phase 6): provenance on ai_skills. Every column is
-- nullable or defaulted, and the default is the backfill — existing skills are
-- 'manual'. Reversible under expand/contract: the previous release neither
-- reads nor writes any of it.
ALTER TABLE "ai_skills" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "source_connector_id" UUID,
ADD COLUMN "source_path" TEXT,
ADD COLUMN "source_sha" TEXT,
ADD COLUMN "pending_instructions" TEXT,
ADD COLUMN "source_removed_at" TIMESTAMPTZ;

CREATE UNIQUE INDEX "ai_skills_workspace_id_source_connector_id_source_path_key" ON "ai_skills"("workspace_id", "source_connector_id", "source_path");

-- Hand-written: Prisma cannot express a CHECK. The same values as
-- AI_SKILL_SOURCES in @knowledge/contracts; a repo skill always says where from.
ALTER TABLE "ai_skills" ADD CONSTRAINT "ai_skills_source_check"
  CHECK ("source" IN ('manual', 'repo')
    AND ("source" = 'manual' OR ("source_connector_id" IS NOT NULL AND "source_path" IS NOT NULL)));
