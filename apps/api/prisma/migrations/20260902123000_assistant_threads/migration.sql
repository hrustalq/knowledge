-- CreateTable
CREATE TABLE "assistant_threads" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "document_id" UUID,
    "title" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_threads_workspace_id_updated_at_idx" ON "assistant_threads"("workspace_id", "updated_at");

-- CreateIndex
CREATE INDEX "assistant_threads_document_id_idx" ON "assistant_threads"("document_id");

-- CreateIndex
CREATE INDEX "assistant_messages_thread_id_created_at_idx" ON "assistant_messages"("thread_id", "created_at");

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "assistant_threads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
