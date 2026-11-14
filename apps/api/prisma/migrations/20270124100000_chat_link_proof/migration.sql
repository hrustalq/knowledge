-- AlterTable
ALTER TABLE "chat_link_codes" ADD COLUMN     "confirmed_at" TIMESTAMPTZ,
ADD COLUMN     "confirmed_by" UUID,
ADD COLUMN     "proof_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "proof_hash" TEXT;

