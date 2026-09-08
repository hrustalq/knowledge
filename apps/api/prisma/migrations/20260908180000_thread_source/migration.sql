-- AlterTable
ALTER TABLE "document_threads" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'human';

-- AlterTable
ALTER TABLE "merge_request_threads" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'human';
