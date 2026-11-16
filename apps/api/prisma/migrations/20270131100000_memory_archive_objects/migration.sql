-- #1165: export archives move to the bucket; the row keeps where the zip is.
-- An archive is a transient download a client can export again, so existing
-- rows (only on installs that ran an unreleased build) are dropped, not moved.
DELETE FROM "memory_transfer_archives";
ALTER TABLE "memory_transfer_archives" DROP COLUMN "data";
ALTER TABLE "memory_transfer_archives" ADD COLUMN "object_key" TEXT NOT NULL;
ALTER TABLE "memory_transfer_archives" ADD COLUMN "byte_size" INTEGER NOT NULL;

-- Upload bytes leave operation rows too: a queued file or import made by an
-- unreleased build still carries them inline, so it is failed with its bytes cleared.
UPDATE "memory_operations"
   SET "status" = 'failed', "error" = 'Upload stored inline by an earlier build; submit it again.', "payload" = '{}'::jsonb, "completed_at" = now()
 WHERE "status" IN ('queued', 'running') AND "payload" ? 'data_base64';
