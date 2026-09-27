-- Issue #68: per-workspace switch for the page menu's external AI actions.
-- Nullable with no default: null inherits AI_EXTERNAL_ACTIONS_ENABLED, so every
-- existing row keeps today's behaviour and no backfill is needed.
ALTER TABLE "ai_settings" ADD COLUMN "external_ai_actions" BOOLEAN;
