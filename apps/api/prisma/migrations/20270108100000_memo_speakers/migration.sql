-- Who a memo's speakers are (#880): { "<speaker label>": "<user id>" | null },
-- written only by the memo's uploader. Null column = nobody matched yet, which
-- is every existing row. Additive, so the previous release is unaffected. No FK
-- on the user ids inside, per house policy.
ALTER TABLE "memos" ADD COLUMN "speakers" JSONB;
