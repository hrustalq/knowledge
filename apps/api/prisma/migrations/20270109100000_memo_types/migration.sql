-- Memo types (#879, phase 1): a memo's kind (daily, retro, …) and a
-- workspace's own edits to the catalogue. Built-in types are code; a row
-- overrides, hides or adds one. A new table and a nullable column, so the
-- previous release is unaffected. No FK on workspace_id, per house policy.
ALTER TABLE "memos" ADD COLUMN "type" TEXT;

CREATE TABLE "memo_types" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT,
    "guidance" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memo_types_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memo_types_workspace_id_key_key" ON "memo_types"("workspace_id", "key");
