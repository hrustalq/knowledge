-- OAuth for MCP clients (#1352). Expand-only: the previous release ignores the
-- new columns and tables, and an existing key keeps its non-null hash.
ALTER TABLE "api_keys" ALTER COLUMN "key_hash" DROP NOT NULL;
ALTER TABLE "api_keys" ADD COLUMN "oauth_client_id" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "sign_in_method" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "sign_in_provider_id" UUID;

CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirect_uris" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "oauth_clients_kind_created_at_idx" ON "oauth_clients"("kind", "created_at");

CREATE TABLE "oauth_requests" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "state" TEXT,
    "resource" TEXT,
    "code_hash" TEXT,
    "api_key_id" UUID,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "spent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_requests_code_hash_key" ON "oauth_requests"("code_hash");
CREATE INDEX "oauth_requests_expires_at_idx" ON "oauth_requests"("expires_at");

CREATE TABLE "oauth_tokens" (
    "id" UUID NOT NULL,
    "api_key_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "spent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_tokens_token_hash_key" ON "oauth_tokens"("token_hash");
CREATE INDEX "oauth_tokens_api_key_id_idx" ON "oauth_tokens"("api_key_id");
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
