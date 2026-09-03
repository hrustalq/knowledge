-- AlterTable
ALTER TABLE "merge_requests" ADD COLUMN     "is_draft" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "merge_request_reviewers" (
    "id" UUID NOT NULL,
    "merge_request_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merge_request_reviewers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merge_request_threads" (
    "id" UUID NOT NULL,
    "merge_request_id" UUID NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "anchor_type" TEXT,
    "anchor" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merge_request_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merge_request_comments" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merge_request_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merge_request_reviewers_user_id_idx" ON "merge_request_reviewers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "merge_request_reviewers_merge_request_id_user_id_key" ON "merge_request_reviewers"("merge_request_id", "user_id");

-- CreateIndex
CREATE INDEX "merge_request_threads_merge_request_id_idx" ON "merge_request_threads"("merge_request_id");

-- CreateIndex
CREATE INDEX "merge_request_comments_thread_id_created_at_idx" ON "merge_request_comments"("thread_id", "created_at");

-- CreateIndex
CREATE INDEX "merge_requests_author_id_idx" ON "merge_requests"("author_id");

-- AddForeignKey
ALTER TABLE "merge_request_reviewers" ADD CONSTRAINT "merge_request_reviewers_merge_request_id_fkey" FOREIGN KEY ("merge_request_id") REFERENCES "merge_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_request_threads" ADD CONSTRAINT "merge_request_threads_merge_request_id_fkey" FOREIGN KEY ("merge_request_id") REFERENCES "merge_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_request_comments" ADD CONSTRAINT "merge_request_comments_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "merge_request_threads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
