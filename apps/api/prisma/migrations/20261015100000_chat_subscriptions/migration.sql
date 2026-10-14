-- CreateTable
CREATE TABLE "chat_subscriptions" (
    "id" UUID NOT NULL,
    "binding_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "event_kinds" JSONB NOT NULL DEFAULT '[]',
    "delivery" TEXT NOT NULL DEFAULT 'instant',
    "digest_minutes" INTEGER,
    "cursor_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cursor_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "next_due_at" TIMESTAMPTZ,
    "last_delivered_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_subscriptions_binding_id_idx" ON "chat_subscriptions"("binding_id");

-- AddForeignKey
ALTER TABLE "chat_subscriptions" ADD CONSTRAINT "chat_subscriptions_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "chat_channel_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

