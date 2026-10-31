-- #673: internal links between pages, one row per (target, anchor) on each
-- page's default-branch head. A new table the previous image never reads, so
-- a rollback leaves it unused. Filled by ingestion from now on and by
-- `make page-links-backfill` for pages indexed before this migration — never
-- parsed here, since the markdown lives in object storage.
CREATE TABLE "page_links" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_document_id" UUID NOT NULL,
    "source_revision_id" UUID NOT NULL,
    "target_document_id" UUID NOT NULL,
    "target_anchor" TEXT,

    CONSTRAINT "page_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "page_links_source_document_id_idx" ON "page_links"("source_document_id");

CREATE INDEX "page_links_workspace_id_target_document_id_idx" ON "page_links"("workspace_id", "target_document_id");
