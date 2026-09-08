-- Feature 15: comments on the document itself.
--
-- Deliberately a second pair of tables rather than nullable columns on
-- merge_request_threads: a review thread and a page comment share a shape but
-- not a lifecycle. Review threads close with their merge request; page comments
-- outlive every revision of the page they annotate.
CREATE TABLE "document_threads" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    -- text | section | entity; NULL = an unanchored comment on the whole page.
    "anchor_type" TEXT,
    "anchor" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_threads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_comments" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_comments_pkey" PRIMARY KEY ("id")
);

-- The page read loads every thread for one document in creation order.
CREATE INDEX "document_threads_document_id_created_at_idx" ON "document_threads"("document_id", "created_at");
CREATE INDEX "document_comments_thread_id_created_at_idx" ON "document_comments"("thread_id", "created_at");

ALTER TABLE "document_threads" ADD CONSTRAINT "document_threads_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A thread is the only thing a comment can belong to, so it dies with it.
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_thread_id_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "document_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
