-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "progress" DOUBLE PRECISION,
ADD COLUMN     "stage" TEXT,
ADD COLUMN     "warnings" JSONB;
