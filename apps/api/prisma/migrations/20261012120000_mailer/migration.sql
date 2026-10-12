-- Mailer (docs/features/41, #132). Expand-only: every column is nullable or
-- defaulted, so the previous image runs against this schema unchanged.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verified_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "password_reset_tokens" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'reset';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "emailed_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "email_directed" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_created_at_idx" ON "email_verification_tokens"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every account that existed before mail did was trusted as it was.
-- Leaving them null would put a "confirm your email" banner on everybody, and
-- under AUTH_REQUIRE_VERIFIED_EMAIL lock them all out on the day it shipped.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;

-- Backfill: rows written before the mailer are history, not news. Without
-- this, the next coalesced bump of an old unread mention would email it.
UPDATE "notifications" SET "emailed_at" = "created_at" WHERE "emailed_at" IS NULL;
