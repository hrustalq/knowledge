-- Google Drive connector (#338): the Changes API cursor.
--
-- 1. connectors.change_cursor is where the next incremental pull starts
--    reading the source's change feed. Null = never read; the next run walks
--    the whole tree and records a fresh one.
-- 2. connector_runs.change_cursor is the cursor a run read at its start. It is
--    copied onto the connector only when the run finishes, so a run that fails
--    halfway leaves the connector where it was and the next one re-reads the
--    same changes.
--
-- Additive and reversible under expand/contract: the previous release ignores
-- both columns.

-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "change_cursor" TEXT;

-- AlterTable
ALTER TABLE "connector_runs" ADD COLUMN     "change_cursor" TEXT;
