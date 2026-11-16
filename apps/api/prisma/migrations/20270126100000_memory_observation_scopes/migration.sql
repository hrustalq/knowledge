-- Observation scopes (#1157). Additive and backfilled: the previous image
-- ignores the new rows and columns, so a code rollback remains safe.

ALTER TABLE "memory_banks"
ADD COLUMN "observations_mission" TEXT,
ADD COLUMN "max_observations_per_scope" INTEGER,
ADD COLUMN "consolidation_source_facts_max_tokens" INTEGER,
ADD COLUMN "consolidation_source_facts_max_tokens_per_observation" INTEGER,
ADD COLUMN "consolidation_strategies" JSONB;

ALTER TABLE "memory_units"
ADD COLUMN "observation_scopes" JSONB,
ADD COLUMN "observation_scope_id" UUID;

CREATE TABLE "memory_observation_scopes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_observation_scopes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_observation_scope_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "scope_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "consolidated_at" TIMESTAMPTZ,
    "claimed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_observation_scope_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_observation_scopes_bank_id_tags_key" ON "memory_observation_scopes"("bank_id", "tags");
CREATE INDEX "memory_observation_scopes_workspace_id_idx" ON "memory_observation_scopes"("workspace_id");
CREATE UNIQUE INDEX "memory_observation_scope_members_scope_id_unit_id_key" ON "memory_observation_scope_members"("scope_id", "unit_id");
CREATE INDEX "memory_observation_scope_members_unit_id_idx" ON "memory_observation_scope_members"("unit_id");
CREATE INDEX "memory_observation_scope_members_bank_id_scope_id_consolidated_at_claimed_at_idx" ON "memory_observation_scope_members"("bank_id", "scope_id", "consolidated_at", "claimed_at");
CREATE INDEX "memory_units_observation_scope_id_idx" ON "memory_units"("observation_scope_id");

-- Backfill: every legacy exact-tag stream becomes one scope. Source facts keep
-- their consolidated/claim state independently in it, and observations keep
-- their ids, evidence and history.
INSERT INTO "memory_observation_scopes" ("id", "workspace_id", "bank_id", "tags")
SELECT gen_random_uuid(), "workspace_id", "bank_id", "tags"
FROM (
    SELECT DISTINCT "workspace_id", "bank_id", "tags" FROM "memory_units"
) AS legacy
ON CONFLICT DO NOTHING;

INSERT INTO "memory_observation_scope_members"
    ("id", "workspace_id", "bank_id", "scope_id", "unit_id", "consolidated_at", "claimed_at")
SELECT gen_random_uuid(), u."workspace_id", u."bank_id", s."id", u."id",
       u."consolidated_at", u."consolidation_claimed_at"
FROM "memory_units" u
JOIN "memory_observation_scopes" s
  ON s."bank_id" = u."bank_id" AND s."tags" = u."tags"
WHERE u."fact_type" <> 'observation'
ON CONFLICT DO NOTHING;

UPDATE "memory_units" u
SET "observation_scope_id" = s."id"
FROM "memory_observation_scopes" s
WHERE u."fact_type" = 'observation'
  AND s."bank_id" = u."bank_id" AND s."tags" = u."tags";

ALTER TABLE "memory_observation_scopes" ADD CONSTRAINT "memory_observation_scopes_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "memory_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_observation_scope_members" ADD CONSTRAINT "memory_observation_scope_members_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "memory_observation_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_observation_scope_members" ADD CONSTRAINT "memory_observation_scope_members_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "memory_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_units" ADD CONSTRAINT "memory_units_observation_scope_id_fkey" FOREIGN KEY ("observation_scope_id") REFERENCES "memory_observation_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
