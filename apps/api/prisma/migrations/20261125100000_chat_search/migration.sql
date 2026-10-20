-- Searchable chat (#339, phase 1). Expand-only: two new tables and three
-- nullable columns, so the previous release runs against it unchanged and a
-- rollback needs no down migration. The tables start empty — nothing is kept
-- until an admin makes a binding searchable — so there is nothing to backfill.

-- AlterTable
ALTER TABLE "chat_channel_bindings" ADD COLUMN     "searchable_at" TIMESTAMPTZ,
ADD COLUMN     "searchable_by" UUID;

-- AlterTable
ALTER TABLE "workspace_settings" ADD COLUMN     "chat_search_retention_days" INTEGER;

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "binding_id" UUID NOT NULL,
    "thread_key" TEXT NOT NULL,
    "external_message_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ NOT NULL,
    "edited_at" TIMESTAMPTZ,
    "chunk_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_chunks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "binding_id" UUID NOT NULL,
    "thread_key" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "first_at" TIMESTAMPTZ NOT NULL,
    "last_at" TIMESTAMPTZ NOT NULL,
    "message_count" INTEGER NOT NULL,
    "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('russian', "text")) STORED,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_messages_binding_id_thread_key_sent_at_idx" ON "chat_messages"("binding_id", "thread_key", "sent_at");

-- CreateIndex
CREATE INDEX "chat_messages_chunk_id_idx" ON "chat_messages"("chunk_id");

-- CreateIndex
CREATE INDEX "chat_messages_author_id_idx" ON "chat_messages"("author_id");

-- CreateIndex
CREATE INDEX "chat_messages_sent_at_idx" ON "chat_messages"("sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_binding_id_external_message_id_key" ON "chat_messages"("binding_id", "external_message_id");

-- CreateIndex
CREATE INDEX "chat_chunks_binding_id_last_at_idx" ON "chat_chunks"("binding_id", "last_at");

-- CreateIndex
CREATE INDEX "chat_chunks_last_at_idx" ON "chat_chunks"("last_at");

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "chat_channel_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "chat_chunks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_chunks" ADD CONSTRAINT "chat_chunks_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "chat_channel_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Full-text leg of chat search. Not expressible in the Prisma schema.
CREATE INDEX "chat_chunks_search_tsv_gin" ON "chat_chunks" USING gin ("search_tsv");
