-- Chat bots, phase 4 (issue #71): the Time adapter.
--
-- Additive and rollback-safe: the previous release never reads server_url or
-- thread_id, inserts Telegram rows with server_url defaulting to '', and the
-- widened unique behaves exactly like the old one for those rows.

-- AlterTable
ALTER TABLE "chat_integrations" ADD COLUMN "server_url" TEXT NOT NULL DEFAULT '';

-- A Time bot is named per server, so the server joins the bot-account unique.
DROP INDEX "chat_integrations_kind_bot_username_key";
CREATE UNIQUE INDEX "chat_integrations_kind_server_url_bot_username_key" ON "chat_integrations"("kind", "server_url", "bot_username");

-- AlterTable
ALTER TABLE "chat_answers" ADD COLUMN "thread_id" TEXT;

-- CreateIndex
CREATE INDEX "chat_answers_integration_id_external_chat_id_thread_id_idx" ON "chat_answers"("integration_id", "external_chat_id", "thread_id");
