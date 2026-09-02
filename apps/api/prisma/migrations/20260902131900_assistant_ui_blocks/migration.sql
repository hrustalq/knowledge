-- AlterTable
ALTER TABLE "assistant_messages" ADD COLUMN "ui_blocks" JSONB NOT NULL DEFAULT '[]';
