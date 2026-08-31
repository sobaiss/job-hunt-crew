-- AlterTable
ALTER TABLE "Analysis" ADD COLUMN     "ingestionJobId" TEXT;

-- AlterTable
ALTER TABLE "IngestionJob" ADD COLUMN     "cvVersionId" TEXT;

-- CreateIndex
CREATE INDEX "Analysis_ingestionJobId_idx" ON "Analysis"("ingestionJobId");

-- AddForeignKey
ALTER TABLE "IngestionJob" ADD CONSTRAINT "IngestionJob_cvVersionId_fkey" FOREIGN KEY ("cvVersionId") REFERENCES "CVVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_ingestionJobId_fkey" FOREIGN KEY ("ingestionJobId") REFERENCES "IngestionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
