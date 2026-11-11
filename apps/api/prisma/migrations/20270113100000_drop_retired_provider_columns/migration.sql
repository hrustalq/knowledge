-- #803 step 2: drop the provider columns #798 retired. Pins, prices and
-- capabilities live on ai_models since v0.46.0; #905 took these fields out of
-- schema.prisma one release earlier (v0.50.0), so no image from v0.50.0 on
-- declares them. Irreversible: a rollback can go no further back than v0.50.0.
-- Hand-written: `prisma migrate diff` also emits raw-SQL drift (index drops,
-- chat_* defaults) that must not ship.

ALTER TABLE "ai_settings"
  DROP COLUMN "chat_provider_id",
  DROP COLUMN "review_provider_id",
  DROP COLUMN "extraction_provider_id",
  DROP COLUMN "decision_provider_id";
ALTER TABLE "ai_agents" DROP COLUMN "provider_id";
ALTER TABLE "assistant_threads" DROP COLUMN "provider_id";
ALTER TABLE "ai_providers"
  DROP COLUMN "model",
  DROP COLUMN "price_prompt_per_mtok",
  DROP COLUMN "price_completion_per_mtok",
  DROP COLUMN "price_cached_per_mtok",
  DROP COLUMN "price_currency",
  DROP COLUMN "capabilities";
