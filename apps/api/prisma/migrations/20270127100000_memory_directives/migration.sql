-- Scoped reflect directives (#1159). Additive: the previous image ignores this
-- table, so a code rollback remains safe.

CREATE TABLE "memory_directives" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_directives_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memory_directives_workspace_id_idx" ON "memory_directives"("workspace_id");
CREATE INDEX "memory_directives_bank_id_is_active_idx" ON "memory_directives"("bank_id", "is_active");

ALTER TABLE "memory_directives" ADD CONSTRAINT "memory_directives_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "memory_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
