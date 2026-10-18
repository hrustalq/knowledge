-- #75 phase 5: SCIM provisioning. Additive only: a code rollback leaves both
-- columns unread, and scim_users has had no writer before this release.

-- AlterTable
ALTER TABLE "workspace_settings" ADD COLUMN "scim_default_role" TEXT;

-- AlterTable
ALTER TABLE "scim_users" ADD COLUMN "user_name" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "scim_users_workspace_id_user_name_key" ON "scim_users"("workspace_id", "user_name");
