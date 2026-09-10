-- CreateTable
CREATE TABLE "glossary_exclusions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "anchor" JSONB NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "glossary_exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "glossary_exclusions_document_id_idx" ON "glossary_exclusions"("document_id");

-- CreateIndex
CREATE INDEX "glossary_exclusions_term_id_idx" ON "glossary_exclusions"("term_id");
