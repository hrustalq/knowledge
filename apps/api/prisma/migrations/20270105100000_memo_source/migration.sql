-- Plaud import (#864): where a memo came from, and the recording's id at its
-- source, so importing one recording twice is one memo. Additive and safe
-- under the previous release: `source` has a default, `external_id` is
-- nullable, and Postgres never counts two NULL `external_id`s as duplicates,
-- so uploads are untouched by the unique index.
ALTER TABLE "memos"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'upload',
  ADD COLUMN "external_id" TEXT;

CREATE UNIQUE INDEX "memos_workspace_id_created_by_source_external_id_key"
  ON "memos"("workspace_id", "created_by", "source", "external_id");
