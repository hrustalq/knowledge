-- #1169: a thread remembers its first turn that carried private input (personal
-- memory, a draft, an attachment); later turns are not copied to a project bank.
ALTER TABLE "assistant_threads" ADD COLUMN "private_context_at" TIMESTAMPTZ;

-- Whether an existing thread carried a draft or an attachment was never stored,
-- so every existing thread counts as private: continuing one retains personally.
UPDATE "assistant_threads" SET "private_context_at" = "created_at";
