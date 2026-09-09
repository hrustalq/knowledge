-- docs/features/18: the UI + API language.
--
-- users.locale is the durable preference (the kn_lang cookie mirrors it so SSR
-- renders in the right language, but a cookie does not follow a user to another
-- browser). import_jobs.locale and workflow_runs.locale freeze the initiator's
-- language at creation: both produce prose in a worker, long after the request
-- that started them is gone, so there is no Accept-Language left to read.
--
-- Additive with a default, so the existing rows fill themselves and every row
-- keeps behaving exactly as it did before this feature.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en';

-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en';

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en';
