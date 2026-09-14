-- AlterTable
ALTER TABLE "ai_settings" ADD COLUMN     "extraction_max_chunks" INTEGER,
ADD COLUMN     "extraction_min_confidence" DOUBLE PRECISION;
