-- Named API keys (docs/features/33). Expand only: users.api_key_hash stays and
-- keeps its values, so the previous image still authenticates after a rollback.

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'write',
    "workspace_id" UUID,
    "expires_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_created_at_idx" ON "api_keys"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing key keeps working, now as a named row. The
-- plaintext was never stored, so the prefix cannot be recovered — the row says
-- so rather than inventing one.
INSERT INTO "api_keys" ("id", "user_id", "name", "key_hash", "prefix", "scope", "created_at")
SELECT gen_random_uuid(), "id", 'Original key', "api_key_hash", 'kn_…', 'write', "created_at"
FROM "users"
WHERE "api_key_hash" IS NOT NULL;
