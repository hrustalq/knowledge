-- #81 phase 2: release tags, named instants that `asOf=tag:<name>` resolves to.
-- A new table only; no FK on workspace_id, project_id or created_by (house policy).
CREATE TABLE "release_tags" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "name" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL,
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_tags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "release_tags_workspace_id_name_key" ON "release_tags"("workspace_id", "name");
CREATE INDEX "release_tags_workspace_id_at_idx" ON "release_tags"("workspace_id", "at");
