-- AlterTable
ALTER TABLE "IngestionJob" ADD COLUMN     "alreadySeenCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "runLimitSkippedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ScoutRun" ADD COLUMN     "alreadySeenCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "runLimitSkippedCount" INTEGER NOT NULL DEFAULT 0;
