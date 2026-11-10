-- Per-user credentials (#857, phase 1). Additive only: the previous release
-- never reads these, so it keeps running against a migrated database. Sign-ins
-- move at the end of this file; pasted tokens move at API boot
-- (backfillCredentials), because they are matched by their decrypted secret.

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


-- Sign-ins need no decryption, so they move here rather than at boot: no
-- OAuth reader ever sees a sign-in that has not moved yet. `updated_at` is
-- now(), so the boot backfill sees nothing newer to copy.
INSERT INTO "credentials" ("id", "user_id", "provider", "method", "account_id", "account_label", "account_avatar_url",
  "secret", "refresh_secret", "expires_at", "refresh_expires_at", "created_at", "updated_at")
SELECT gen_random_uuid(), "user_id", 'github', 'oauth', "github_user_id"::text, "github_login", "github_avatar_url",
  "access_token", "refresh_token", "expires_at", "refresh_expires_at", "created_at", now()
FROM "github_user_tokens";

INSERT INTO "credentials" ("id", "user_id", "provider", "method", "account_id", "account_label",
  "secret", "refresh_secret", "expires_at", "created_at", "updated_at")
SELECT gen_random_uuid(), "connected_by", 'figma', 'oauth', "figma_user_id", "handle",
  "access_token", "refresh_token", "expires_at", "created_at", now()
FROM "figma_oauth_grants";

UPDATE "connections" n SET "credential_id" = c."id"
FROM "credentials" c
WHERE n."provider" = 'figma' AND n."method" = 'oauth' AND c."provider" = 'figma' AND c."method" = 'oauth'
  AND c."account_id" = n."external_ref";
