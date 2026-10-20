-- AlterTable
ALTER TABLE "workspace_settings" ADD COLUMN     "analytics_enabled" BOOLEAN,
ADD COLUMN     "analytics_retention_days" INTEGER;

-- CreateTable
CREATE TABLE "page_views" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "document_id" UUID NOT NULL,
    "revision_id" UUID,
    "channel" TEXT NOT NULL,
    "reader_key" TEXT,
    "api_key_id" UUID,
    "search_id" UUID,
    "search_rank" INTEGER,
    "active_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_queries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_ids" JSONB NOT NULL DEFAULT '[]',
    "query_text" TEXT,
    "query_hash" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "result_count" INTEGER NOT NULL,
    "result_doc_ids" JSONB NOT NULL DEFAULT '[]',
    "channel" TEXT NOT NULL,
    "reader_key" TEXT,
    "api_key_id" UUID,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_tool_calls" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "tool" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error_code" TEXT,
    "reader_key" TEXT,
    "api_key_id" UUID,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "page_views_workspace_id_created_at_idx" ON "page_views"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "page_views_project_id_created_at_idx" ON "page_views"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "page_views_document_id_created_at_idx" ON "page_views"("document_id", "created_at");

-- CreateIndex
CREATE INDEX "page_views_search_id_idx" ON "page_views"("search_id");

-- CreateIndex
CREATE INDEX "search_queries_workspace_id_created_at_idx" ON "search_queries"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "search_queries_workspace_id_query_hash_created_at_idx" ON "search_queries"("workspace_id", "query_hash", "created_at");

-- CreateIndex
CREATE INDEX "search_queries_workspace_id_result_count_created_at_idx" ON "search_queries"("workspace_id", "result_count", "created_at");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_workspace_id_created_at_idx" ON "mcp_tool_calls"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_api_key_id_created_at_idx" ON "mcp_tool_calls"("api_key_id", "created_at");

