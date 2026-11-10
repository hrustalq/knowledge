-- Plaud auto-import (#864): a person's pick rules per workspace, and one row
-- per recording those rules picked. New tables only, so the previous release
-- is unaffected. No FK on workspace_id / user_id, per house policy.
CREATE TABLE "plaud_links" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "project_id" UUID,
    "rules" JSONB NOT NULL DEFAULT '{}',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "checked_at" TIMESTAMPTZ,
    "reconnect_notified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plaud_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "plaud_imports" (
    "id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_at" TIMESTAMPTZ,
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "memo_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plaud_imports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plaud_links_workspace_id_user_id_key" ON "plaud_links"("workspace_id", "user_id");
CREATE INDEX "plaud_links_checked_at_idx" ON "plaud_links"("checked_at");
CREATE UNIQUE INDEX "plaud_imports_link_id_external_id_key" ON "plaud_imports"("link_id", "external_id");
CREATE INDEX "plaud_imports_workspace_id_user_id_status_idx" ON "plaud_imports"("workspace_id", "user_id", "status");

ALTER TABLE "plaud_imports" ADD CONSTRAINT "plaud_imports_link_id_fkey"
  FOREIGN KEY ("link_id") REFERENCES "plaud_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
