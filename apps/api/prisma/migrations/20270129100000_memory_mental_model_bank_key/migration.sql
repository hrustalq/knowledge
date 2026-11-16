-- A mental model id is chosen by the client and unique per bank only (#1160):
-- the primary key becomes (bank_id, id) and history references the pair.
-- Both tables are small and unreleased, so the keys are swapped in place.
-- refreshed_scope fingerprints the tag/fact-type scope the content was built
-- from; nullable, so the previous image ignores it.

ALTER TABLE "memory_mental_model_history" DROP CONSTRAINT "memory_mental_model_history_model_id_fkey";
ALTER TABLE "memory_mental_models" DROP CONSTRAINT "memory_mental_models_pkey";
ALTER TABLE "memory_mental_models" ADD CONSTRAINT "memory_mental_models_pkey" PRIMARY KEY ("bank_id", "id");
ALTER TABLE "memory_mental_model_history" ADD CONSTRAINT "memory_mental_model_history_bank_id_model_id_fkey" FOREIGN KEY ("bank_id", "model_id") REFERENCES "memory_mental_models"("bank_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "memory_mental_model_history_model_id_changed_at_idx";
CREATE INDEX "memory_mental_model_history_bank_id_model_id_changed_at_idx" ON "memory_mental_model_history"("bank_id", "model_id", "changed_at");

ALTER TABLE "memory_mental_models" ADD COLUMN "refreshed_scope" TEXT;
