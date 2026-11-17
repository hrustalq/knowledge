-- Methodologies (#1121, phase 6): the level a chat thread works at. Nullable;
-- null is every thread before this phase, and sends the same prompt as before.
ALTER TABLE "assistant_threads" ADD COLUMN "level" TEXT;
