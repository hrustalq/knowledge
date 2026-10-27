-- Memos (#551, docs/features/68): a recording, its masked transcript and the
-- analysis that proposes merge requests. A new table with no backfill, and a
-- nullable column on ai_usage — both survive a rollback to the previous image,
-- which never reads them.

-- AlterTable
ALTER TABLE "ai_usage" ADD COLUMN "audio_seconds" INTEGER;

-- CreateTable
CREATE TABLE "memos" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "audio_key" TEXT NOT NULL,
    "audio_purged_at" TIMESTAMPTZ,
    "duration_seconds" INTEGER,
    "language" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT,
    "error" TEXT,
    "transcript" JSONB,
    "summary" TEXT,
    "dropped" JSONB,
    "agent_run_id" UUID,
    "published_at" TIMESTAMPTZ,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memos_workspace_id_created_by_created_at_idx" ON "memos"("workspace_id", "created_by", "created_at");

-- CreateIndex
CREATE INDEX "memos_status_idx" ON "memos"("status");
