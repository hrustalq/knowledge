-- #716 phase 4: saved blueprints. New tables only, so the previous image runs
-- against this schema unchanged and a rollback leaves them unread.
CREATE TABLE "project_blueprints" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "built_in_key" TEXT,
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_blueprints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_blueprint_versions" (
    "id" UUID NOT NULL,
    "blueprint_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "blueprint" JSONB NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_blueprint_versions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_blueprints_workspace_id_built_in_key_idx" ON "project_blueprints"("workspace_id", "built_in_key");

CREATE UNIQUE INDEX "project_blueprint_versions_blueprint_id_version_key" ON "project_blueprint_versions"("blueprint_id", "version");

ALTER TABLE "project_blueprint_versions" ADD CONSTRAINT "project_blueprint_versions_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "project_blueprints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
