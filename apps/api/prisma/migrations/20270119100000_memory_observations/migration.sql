-- Memory observations (#993). Additive: the previous release ignores every
-- column and table here, so it survives a rollback.

-- AlterTable
ALTER TABLE "memory_banks" ADD COLUMN "enable_observations" BOOLEAN,
ADD COLUMN "consolidation_day" DATE,
ADD COLUMN "consolidation_calls" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "memory_units" ADD COLUMN "consolidated_at" TIMESTAMPTZ,
ADD COLUMN "consolidation_claimed_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "ai_settings" ADD COLUMN "decision_memory_threshold" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "memory_observation_evidence" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "observation_id" UUID NOT NULL,
    "fact_id" UUID NOT NULL,
    "quote" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_observation_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_observation_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "observation_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_observation_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_units_bank_id_consolidated_at_idx" ON "memory_units"("bank_id", "consolidated_at");

-- CreateIndex
CREATE INDEX "memory_observation_evidence_fact_id_idx" ON "memory_observation_evidence"("fact_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_observation_evidence_observation_id_fact_id_key" ON "memory_observation_evidence"("observation_id", "fact_id");

-- CreateIndex
CREATE INDEX "memory_observation_history_observation_id_created_at_idx" ON "memory_observation_history"("observation_id", "created_at");

-- AddForeignKey
ALTER TABLE "memory_observation_evidence" ADD CONSTRAINT "memory_observation_evidence_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "memory_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_observation_evidence" ADD CONSTRAINT "memory_observation_evidence_fact_id_fkey" FOREIGN KEY ("fact_id") REFERENCES "memory_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_observation_history" ADD CONSTRAINT "memory_observation_history_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "memory_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
