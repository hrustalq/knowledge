-- Chat harvest, phase 3 (#82): Telegram listening and DM forwards.
--
-- 1. chat_channel_bindings gains `listening` (default false: nothing is kept
--    until a workspace admin turns it on).
-- 2. chat_buffered_messages holds masked messages a harvest may read. Rows
--    cascade with their bot and their binding.
--
-- Additive and reversible under expand/contract: the previous release ignores
-- the column and the table. A rollback leaves kept rows behind until this
-- release's sweeper runs again; drop the table by hand if the rollback is final.

-- AlterTable
ALTER TABLE "chat_channel_bindings" ADD COLUMN     "listening" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "chat_buffered_messages" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "binding_id" UUID,
    "external_chat_id" TEXT NOT NULL,
    "topic_id" TEXT,
    "external_message_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_buffered_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_buffered_messages_integration_id_external_chat_id_topi_idx" ON "chat_buffered_messages"("integration_id", "external_chat_id", "topic_id", "sent_at");

-- CreateIndex
CREATE INDEX "chat_buffered_messages_author_id_idx" ON "chat_buffered_messages"("author_id");

-- CreateIndex
CREATE INDEX "chat_buffered_messages_created_at_idx" ON "chat_buffered_messages"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_buffered_messages_integration_id_external_chat_id_exte_key" ON "chat_buffered_messages"("integration_id", "external_chat_id", "external_message_id");

-- AddForeignKey
ALTER TABLE "chat_buffered_messages" ADD CONSTRAINT "chat_buffered_messages_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "chat_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_buffered_messages" ADD CONSTRAINT "chat_buffered_messages_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "chat_channel_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

