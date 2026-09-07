-- Confluence-style page attachments: images, PDFs and files embedded in the
-- rich editor. Bytes live in MinIO under the document's prefix; this row is the
-- addressable handle the stored markdown links to.
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "s3_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "attachments_document_id_created_at_idx" ON "attachments"("document_id", "created_at");
CREATE INDEX "attachments_workspace_id_created_at_idx" ON "attachments"("workspace_id", "created_at");

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
