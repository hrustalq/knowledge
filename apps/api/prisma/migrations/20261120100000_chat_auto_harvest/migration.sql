-- Automatic harvest (#340): a listening group's threads harvested by a sweeper.
--
-- 1. chat_channel_bindings gains `auto_harvest_by` / `auto_harvest_at`: the
--    workspace admin who turned it on (the captures are theirs) and when. Both
--    nullable; null is off, so every existing binding stays manual-only.
-- 2. chat_harvest_marks holds, per listening thread (a group, or a forum
--    topic of one), how far the last automatic harvest read. Rows cascade with
--    their binding.
--
-- Additive and reversible under expand/contract: the previous release ignores
-- the columns and the table. Drop them by hand if a rollback is final.

-- AlterTable
ALTER TABLE "chat_channel_bindings" ADD COLUMN     "auto_harvest_at" TIMESTAMPTZ,
ADD COLUMN     "auto_harvest_by" UUID;

-- CreateTable
CREATE TABLE "chat_harvest_marks" (
    "id" UUID NOT NULL,
    "binding_id" UUID NOT NULL,
    "topic_key" TEXT NOT NULL DEFAULT '',
    "harvested_through" TIMESTAMPTZ NOT NULL,
    "harvested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_harvest_marks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_harvest_marks_binding_id_topic_key_key" ON "chat_harvest_marks"("binding_id", "topic_key");

-- AddForeignKey
ALTER TABLE "chat_harvest_marks" ADD CONSTRAINT "chat_harvest_marks_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "chat_channel_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

