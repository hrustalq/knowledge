-- Methodologies (#1121, phase 5): model tiers and methodology agents. All
-- nullable; null resolves every agent exactly as before.
ALTER TABLE "ai_models" ADD COLUMN "tier" TEXT;
ALTER TABLE "ai_agents" ADD COLUMN "blueprint_id" UUID;
ALTER TABLE "ai_agents" ADD COLUMN "min_tier" TEXT;
