-- CreateEnum
CREATE TYPE "ScoutRunStatus" AS ENUM ('PENDING', 'RUNNING', 'PARTIALLY_COMPLETED', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Analysis" ADD COLUMN     "scoutId" TEXT;

-- AlterTable
ALTER TABLE "IngestionJob" ADD COLUMN     "scoutRunId" TEXT;

-- CreateTable
CREATE TABLE "ScoutRun" (
    "id" TEXT NOT NULL,
    "scoutId" TEXT NOT NULL,
    "status" "ScoutRunStatus" NOT NULL DEFAULT 'PENDING',
    "sitesQueried" INTEGER NOT NULL DEFAULT 0,
    "siteUnavailableCount" INTEGER NOT NULL DEFAULT 0,
    "offersDiscovered" INTEGER NOT NULL DEFAULT 0,
    "offersAnalysed" INTEGER NOT NULL DEFAULT 0,
    "relevantCount" INTEGER NOT NULL DEFAULT 0,
    "documentsGeneratedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "capSkippedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoutRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScoutRun_scoutId_idx" ON "ScoutRun"("scoutId");

-- CreateIndex
CREATE INDEX "Analysis_scoutId_idx" ON "Analysis"("scoutId");

-- CreateIndex
CREATE INDEX "IngestionJob_scoutRunId_idx" ON "IngestionJob"("scoutRunId");

-- AddForeignKey
ALTER TABLE "IngestionJob" ADD CONSTRAINT "IngestionJob_scoutRunId_fkey" FOREIGN KEY ("scoutRunId") REFERENCES "ScoutRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoutRun" ADD CONSTRAINT "ScoutRun_scoutId_fkey" FOREIGN KEY ("scoutId") REFERENCES "Scout"("id") ON DELETE CASCADE ON UPDATE CASCADE;
