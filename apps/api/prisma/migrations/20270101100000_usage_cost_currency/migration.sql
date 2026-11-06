-- #793: a cost and a price each state their currency.
ALTER TABLE "ai_usage" ADD COLUMN "cost_currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "ai_settings" ADD COLUMN "price_cached_per_mtok" DECIMAL(12,6), ADD COLUMN "price_currency" TEXT;
ALTER TABLE "ai_providers" ADD COLUMN "price_cached_per_mtok" DECIMAL(12,6), ADD COLUMN "price_currency" TEXT;

-- gen-stt reports rubles, and they were stored as they came: the amounts are right, the label was wrong.
UPDATE "ai_usage"
SET "cost_currency" = 'RUB'
WHERE "operation" = 'transcription' AND "provider" = 'gen-api' AND "cost_usd_micros" IS NOT NULL;
