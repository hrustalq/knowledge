-- #75 phase 1: enterprise auth foundations (SSO, SCIM, group → role mapping).
-- Expand-only. New columns carry defaults that are true of every existing row
-- (a session was opened with a password, a membership was granted by hand), so
-- nothing is backfilled. audit_logs.workspace_id becomes nullable for platform
-- events; the previous release's image only ever reads it filtered by a
-- workspace, so it never meets a null. A code rollback needs no database step.
-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "auth_method" TEXT NOT NULL DEFAULT 'password',
ADD COLUMN     "idp_session_id" TEXT,
ADD COLUMN     "ip" TEXT,
ADD COLUMN     "last_seen_at" TIMESTAMPTZ,
ADD COLUMN     "provider_id" UUID,
ADD COLUMN     "user_agent" TEXT;

-- AlterTable
ALTER TABLE "workspace_members" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "ip" TEXT,
ADD COLUMN     "target" TEXT,
ALTER COLUMN "workspace_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "workspace_settings" ADD COLUMN     "allow_api_keys" BOOLEAN,
ADD COLUMN     "allow_password_for_admins" BOOLEAN,
ADD COLUMN     "session_max_age_hours" INTEGER,
ADD COLUMN     "sso_enforced" BOOLEAN;

-- CreateTable
CREATE TABLE "identity_providers" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "preset" TEXT NOT NULL DEFAULT 'generic',
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "show_on_login" BOOLEAN NOT NULL DEFAULT true,
    "platform_wide" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secret_cipher" TEXT,
    "jit_enabled" BOOLEAN NOT NULL DEFAULT false,
    "default_role" TEXT,
    "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "groups_claim" TEXT,
    "group_sync_mode" TEXT NOT NULL DEFAULT 'additive',
    "session_ttl_hours" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "identity_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "email_at_link" TEXT,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_domains" (
    "domain" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider_id" UUID,
    "verification_token" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ,
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_domains_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "idp_group_mappings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider_id" UUID,
    "external_group" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "trusted_operator" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idp_group_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_users" (
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "external_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "scim_users_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- CreateTable
CREATE TABLE "scim_groups" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "external_id" TEXT,
    "display_name" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_group_members" (
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "scim_group_members_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "sso_auth_requests" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "state_hash" TEXT NOT NULL,
    "nonce" TEXT,
    "code_verifier" TEXT,
    "saml_request_id" TEXT,
    "return_to" TEXT NOT NULL,
    "exchange_code_hash" TEXT,
    "user_id" UUID,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_auth_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_providers_workspace_id_idx" ON "identity_providers"("workspace_id");

-- CreateIndex
CREATE INDEX "user_identities_user_id_idx" ON "user_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_provider_id_subject_key" ON "user_identities"("provider_id", "subject");

-- CreateIndex
CREATE INDEX "sso_domains_workspace_id_idx" ON "sso_domains"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "idp_group_mappings_workspace_id_provider_id_external_group_key" ON "idp_group_mappings"("workspace_id", "provider_id", "external_group");

-- CreateIndex
CREATE UNIQUE INDEX "scim_tokens_token_hash_key" ON "scim_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "scim_tokens_workspace_id_idx" ON "scim_tokens"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_users_workspace_id_external_id_key" ON "scim_users"("workspace_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_groups_workspace_id_display_name_key" ON "scim_groups"("workspace_id", "display_name");

-- CreateIndex
CREATE UNIQUE INDEX "sso_auth_requests_state_hash_key" ON "sso_auth_requests"("state_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sso_auth_requests_exchange_code_hash_key" ON "sso_auth_requests"("exchange_code_hash");

-- CreateIndex
CREATE INDEX "sso_auth_requests_expires_at_idx" ON "sso_auth_requests"("expires_at");

-- CreateIndex
CREATE INDEX "sessions_provider_id_idp_session_id_idx" ON "sessions"("provider_id", "idp_session_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_group_mappings" ADD CONSTRAINT "idp_group_mappings_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "scim_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_auth_requests" ADD CONSTRAINT "sso_auth_requests_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "identity_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

