-- Runtime-owned memory banks: one per agent+user, or one shared by a project.
ALTER TABLE "memory_banks" ADD COLUMN "agent_key" TEXT;
ALTER TABLE "memory_banks" ADD COLUMN "owner_id" UUID;

CREATE INDEX "memory_banks_workspace_id_agent_key_owner_id_idx"
ON "memory_banks"("workspace_id", "agent_key", "owner_id");
