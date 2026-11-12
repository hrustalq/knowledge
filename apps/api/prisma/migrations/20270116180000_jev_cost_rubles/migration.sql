-- Jev decision rows were stored from the response's `usage.cost`, a USD figure
-- about 250× below what gen-api charges (#932). gen-api bills Jev in rubles at
-- 10.5 ₽ per 1M input tokens, so a row's cost in micro-rubles is its tokens × 10.5.
-- Only these rows are gen-api + USD: every other gen-api cost is already RUB (#793).
UPDATE "ai_usage"
SET "cost_usd_micros" = ROUND("prompt_tokens" * 10.5), "cost_currency" = 'RUB'
WHERE "provider" = 'gen-api' AND "cost_currency" = 'USD' AND "model" LIKE 'jev%' AND "cost_usd_micros" IS NOT NULL;
