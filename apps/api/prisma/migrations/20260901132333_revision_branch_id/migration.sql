-- AlterTable
ALTER TABLE "document_revisions" ADD COLUMN     "branch_id" UUID;

-- AddForeignKey
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "document_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
