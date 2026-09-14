-- CreateTable
CREATE TABLE "ops_events" (
    "id" UUID NOT NULL,
    "trace_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "code" TEXT,
    "message" TEXT NOT NULL,
    "workspace_id" UUID,
    "user_id" UUID,
    "route" TEXT,
    "duration_ms" INTEGER,
    "fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ops_events_workspace_id_created_at_idx" ON "ops_events"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "ops_events_trace_id_idx" ON "ops_events"("trace_id");

-- CreateIndex
CREATE INDEX "ops_events_code_created_at_idx" ON "ops_events"("code", "created_at");
