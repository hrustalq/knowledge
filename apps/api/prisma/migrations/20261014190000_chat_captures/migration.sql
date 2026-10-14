-- CreateTable
CREATE TABLE "chat_captures" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "answer_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" UUID NOT NULL,
    "reply_message_id" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "title" TEXT,
    "document_id" UUID,
    "merge_request_id" UUID,
    "glossary_term_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_captures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_captures_status_created_at_idx" ON "chat_captures"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_captures_answer_id_kind_key" ON "chat_captures"("answer_id", "kind");

-- AddForeignKey
ALTER TABLE "chat_captures" ADD CONSTRAINT "chat_captures_answer_id_fkey" FOREIGN KEY ("answer_id") REFERENCES "chat_answers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

