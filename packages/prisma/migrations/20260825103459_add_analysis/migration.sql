-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING_CREW', 'AWAITING_RESULT', 'PERSISTING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobOfferId" TEXT NOT NULL,
    "cvVersionId" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "s3ResultKey" TEXT,
    "matchScore" INTEGER,
    "resultJSON" JSONB,
    "errorMessage" TEXT,
    "stepFunctionExecutionArn" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Analysis_userId_idx" ON "Analysis"("userId");

-- CreateIndex
CREATE INDEX "Analysis_jobOfferId_idx" ON "Analysis"("jobOfferId");

-- CreateIndex
CREATE INDEX "Analysis_cvVersionId_idx" ON "Analysis"("cvVersionId");

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_jobOfferId_fkey" FOREIGN KEY ("jobOfferId") REFERENCES "JobOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_cvVersionId_fkey" FOREIGN KEY ("cvVersionId") REFERENCES "CVVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
