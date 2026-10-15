-- Access requests (#76, phase 5). Additive only: one new table nothing older
-- reads, so the previous release's image runs against this schema unchanged.

-- CreateTable
CREATE TABLE "access_requests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by" UUID,
    "decided_level" TEXT,
    "decided_at" TIMESTAMPTZ,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_requests_workspace_id_status_created_at_idx" ON "access_requests"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "access_requests_resource_type_resource_id_status_idx" ON "access_requests"("resource_type", "resource_id", "status");

-- CreateIndex
CREATE INDEX "access_requests_requester_id_status_idx" ON "access_requests"("requester_id", "status");

-- One pending request per person and resource. Partial, so a decided request
-- never blocks asking again; not expressible in Prisma, hence raw here.
CREATE UNIQUE INDEX "access_requests_one_pending" ON "access_requests"("requester_id", "resource_type", "resource_id") WHERE "status" = 'pending';
