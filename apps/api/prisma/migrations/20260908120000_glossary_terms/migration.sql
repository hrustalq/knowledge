-- Glossary (docs/features/14): project-scoped vocabulary linked into rendered
-- pages. Workspace > Project > Document — a term belongs to a project, and
-- workspace_id is denormalized alongside it exactly as on `documents`.
CREATE TABLE "glossary_terms" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "term" TEXT NOT NULL,
    "aliases" JSONB NOT NULL DEFAULT '[]',
    "definition" TEXT NOT NULL,
    "document_id" UUID,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "glossary_terms_pkey" PRIMARY KEY ("id")
);

-- One entry per term per project; aliases carry the spelling variants. Two
-- projects may define the same word differently and neither blocks the other.
CREATE UNIQUE INDEX "glossary_terms_project_id_term_key" ON "glossary_terms"("project_id", "term");

-- The linker asks for one project's enabled terms on every page render; the
-- workspace index backs the unscoped listing.
CREATE INDEX "glossary_terms_workspace_id_enabled_idx" ON "glossary_terms"("workspace_id", "enabled");
CREATE INDEX "glossary_terms_project_id_enabled_idx" ON "glossary_terms"("project_id", "enabled");

-- No FK on document_id (mirrors documents.parent_id): deleting a page must not
-- delete the vocabulary that referenced it.
ALTER TABLE "glossary_terms" ADD CONSTRAINT "glossary_terms_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
