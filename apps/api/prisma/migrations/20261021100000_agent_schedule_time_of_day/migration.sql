-- Time-of-day agent schedules (#70). Every column is nullable and a null kind
-- reads as 'interval', so existing rows need no backfill and behave exactly as
-- before. Reversible under expand/contract: the previous release ignores them.
ALTER TABLE "ai_agents"
  ADD COLUMN "schedule_kind" TEXT,
  ADD COLUMN "schedule_time" TEXT,
  ADD COLUMN "schedule_weekdays" JSONB,
  ADD COLUMN "schedule_timezone" TEXT,
  ADD COLUMN "schedule_changed_at" TIMESTAMPTZ;

-- Hand-written: Prisma cannot express a CHECK. The same pattern as
-- AGENT_SCHEDULE_TIME_PATTERN in @knowledge/contracts.
ALTER TABLE "ai_agents"
  ADD CONSTRAINT "ai_agents_schedule_kind_check"
    CHECK ("schedule_kind" IS NULL OR "schedule_kind" IN ('interval', 'daily', 'weekly')),
  ADD CONSTRAINT "ai_agents_schedule_time_check"
    CHECK ("schedule_time" IS NULL OR "schedule_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
