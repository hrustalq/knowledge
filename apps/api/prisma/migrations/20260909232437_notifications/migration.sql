-- CreateTable
CREATE TABLE "notification_subscriptions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actor" TEXT,
    "document_id" UUID,
    "subject_type" TEXT,
    "subject_id" UUID,
    "title" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "muted_categories" JSONB NOT NULL DEFAULT '[]',
    "auto_watch_on_comment" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id","workspace_id")
);

-- CreateIndex
CREATE INDEX "notification_subscriptions_subject_type_subject_id_idx" ON "notification_subscriptions"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "notification_subscriptions_workspace_id_user_id_idx" ON "notification_subscriptions"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_subscriptions_user_id_subject_type_subject_id_key" ON "notification_subscriptions"("user_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_workspace_id_user_id_created_at_idx" ON "notifications"("workspace_id", "user_id", "created_at");
