-- AlterTable
ALTER TABLE "document_comments" ADD COLUMN     "reply_to_id" UUID;

-- AlterTable
ALTER TABLE "merge_request_comments" ADD COLUMN     "reply_to_id" UUID;

-- AddForeignKey
ALTER TABLE "merge_request_comments" ADD CONSTRAINT "merge_request_comments_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "merge_request_comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "document_comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
