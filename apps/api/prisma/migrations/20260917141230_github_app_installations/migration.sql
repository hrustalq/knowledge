-- CreateTable
CREATE TABLE "github_installations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "installation_id" BIGINT NOT NULL,
    "account_login" TEXT NOT NULL,
    "account_type" TEXT NOT NULL,
    "account_avatar_url" TEXT,
    "repository_selection" TEXT NOT NULL DEFAULT 'all',
    "suspended_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_user_tokens" (
    "user_id" UUID NOT NULL,
    "github_user_id" BIGINT NOT NULL,
    "github_login" TEXT NOT NULL,
    "github_avatar_url" TEXT,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMPTZ,
    "refresh_expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_user_tokens_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "github_installations_workspace_id_idx" ON "github_installations"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_installations_workspace_id_installation_id_key" ON "github_installations"("workspace_id", "installation_id");
