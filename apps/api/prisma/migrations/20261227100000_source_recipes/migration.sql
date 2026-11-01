-- Extraction recipes (#674, phase 2). Additive only: a new table and nullable
-- columns, so the previous release's image runs against it and a rollback by
-- retag needs nothing undone.

ALTER TABLE "connector_links"
  ADD COLUMN "baseline" JSONB,
  ADD COLUMN "fingerprint" JSONB,
  ADD COLUMN "structure_changed_at" TIMESTAMPTZ,
  ADD COLUMN "held_at" TIMESTAMPTZ,
  ADD COLUMN "held_reason" TEXT,
  ADD COLUMN "body_hash" TEXT;

CREATE TABLE "source_recipes" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "connector_id" UUID NOT NULL,
  "document_id" UUID,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "recipe" JSONB NOT NULL,
  "note" TEXT,
  "created_by" UUID,
  "decided_by" UUID,
  "decided_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "source_recipes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "source_recipes_connector_id_version_key" ON "source_recipes"("connector_id", "version");
CREATE INDEX "source_recipes_connector_id_document_id_status_idx" ON "source_recipes"("connector_id", "document_id", "status");

ALTER TABLE "source_recipes" ADD CONSTRAINT "source_recipes_connector_id_fkey"
  FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
