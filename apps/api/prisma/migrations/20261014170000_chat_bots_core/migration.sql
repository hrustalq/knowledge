-- CreateTable
CREATE TABLE "chat_integrations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "credential" TEXT,
    "credential_hint" TEXT,
    "inbound_secret_hash" TEXT,
    "bot_username" TEXT,
    "webhook_error" TEXT,
    "default_agent_key" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_channel_bindings" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "external_chat_id" TEXT NOT NULL,
    "title" TEXT,
    "project_id" UUID,
    "agent_key" TEXT,
    "answer_mode" TEXT NOT NULL DEFAULT 'mention',
    "locale" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_channel_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_identities" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "external_user_name" TEXT,
    "user_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_link_codes" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "external_user_name" TEXT,
    "external_chat_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_link_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "external_chat_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "assistant_thread_id" UUID NOT NULL,
    "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_answers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "external_chat_id" TEXT NOT NULL,
    "inbound_message_id" TEXT NOT NULL,
    "conversation_id" UUID,
    "asked_by" UUID NOT NULL,
    "reply_message_id" TEXT,
    "assistant_message_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "agent_key" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_integrations_workspace_id_name_key" ON "chat_integrations"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "chat_integrations_kind_bot_username_key" ON "chat_integrations"("kind", "bot_username");

-- CreateIndex
CREATE UNIQUE INDEX "chat_channel_bindings_integration_id_external_chat_id_key" ON "chat_channel_bindings"("integration_id", "external_chat_id");

-- CreateIndex
CREATE INDEX "chat_identities_user_id_idx" ON "chat_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_identities_integration_id_external_user_id_key" ON "chat_identities"("integration_id", "external_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_link_codes_code_hash_key" ON "chat_link_codes"("code_hash");

-- CreateIndex
CREATE INDEX "chat_link_codes_integration_id_external_user_id_idx" ON "chat_link_codes"("integration_id", "external_user_id");

-- CreateIndex
CREATE INDEX "chat_conversations_integration_id_external_chat_id_user_id__idx" ON "chat_conversations"("integration_id", "external_chat_id", "user_id", "last_activity_at");

-- CreateIndex
CREATE INDEX "chat_answers_status_created_at_idx" ON "chat_answers"("status", "created_at");

-- CreateIndex
CREATE INDEX "chat_answers_asked_by_created_at_idx" ON "chat_answers"("asked_by", "created_at");

-- CreateIndex
CREATE INDEX "chat_answers_integration_id_external_chat_id_reply_message__idx" ON "chat_answers"("integration_id", "external_chat_id", "reply_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_answers_integration_id_external_chat_id_inbound_messag_key" ON "chat_answers"("integration_id", "external_chat_id", "inbound_message_id");

-- AddForeignKey
ALTER TABLE "chat_channel_bindings" ADD CONSTRAINT "chat_channel_bindings_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "chat_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_identities" ADD CONSTRAINT "chat_identities_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "chat_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_link_codes" ADD CONSTRAINT "chat_link_codes_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "chat_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "chat_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_answers" ADD CONSTRAINT "chat_answers_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "chat_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

