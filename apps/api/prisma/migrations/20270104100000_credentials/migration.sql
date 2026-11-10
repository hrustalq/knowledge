-- Per-user credentials (#857, phase 1). Additive only: the previous release
-- never reads these, so it keeps running against a migrated database. The API
-- boot backfill (backfillCredentials) fills them; SQL cannot, because pasted
-- tokens are matched by their decrypted secret.

-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "credential_id" UUID;

-- CreateTable
CREATE TABLE "credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "provider" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "site" TEXT,
    "account_id" TEXT,
    "account_label" TEXT,
    "account_avatar_url" TEXT,
    "secret" TEXT NOT NULL,
    "secret_hint" TEXT,
    "refresh_secret" TEXT,
    "expires_at" TIMESTAMPTZ,
    "refresh_expires_at" TIMESTAMPTZ,
    "refreshing_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credentials_user_id_provider_idx" ON "credentials"("user_id", "provider");

-- CreateIndex
CREATE INDEX "credentials_provider_method_account_id_idx" ON "credentials"("provider", "method", "account_id");

-- CreateIndex
CREATE INDEX "connections_credential_id_idx" ON "connections"("credential_id");

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

