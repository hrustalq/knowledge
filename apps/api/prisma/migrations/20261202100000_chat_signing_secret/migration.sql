-- Slack bots (#380): the app's signing secret, an AES-256-GCM envelope, kept to
-- verify every delivery's HMAC. NULL for every platform that signs nothing.
-- Nullable and additive: the previous release ignores the column, so this survives a rollback.
ALTER TABLE "chat_integrations" ADD COLUMN "signing_secret" TEXT;
