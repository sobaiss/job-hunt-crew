-- CreateEnum
CREATE TYPE "GeneratedDocumentType" AS ENUM ('COVER_LETTER', 'TAILORED_CV');

-- CreateEnum
CREATE TYPE "GeneratedDocumentStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "GeneratedDocument" (
    "id" TEXT NOT NULL,
    "type" "GeneratedDocumentType" NOT NULL,
    "analysisId" TEXT NOT NULL,
    "jobOfferId" TEXT NOT NULL,
    "cvVersionId" TEXT NOT NULL,
    "scoutRunId" TEXT,
    "status" "GeneratedDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "markdownContent" TEXT,
    "s3Key" TEXT,
    "errorMessage" TEXT,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedDocument_supersededById_key" ON "GeneratedDocument"("supersededById");

-- CreateIndex
CREATE INDEX "GeneratedDocument_analysisId_idx" ON "GeneratedDocument"("analysisId");

-- CreateIndex
CREATE INDEX "GeneratedDocument_jobOfferId_idx" ON "GeneratedDocument"("jobOfferId");

-- CreateIndex
CREATE INDEX "GeneratedDocument_cvVersionId_idx" ON "GeneratedDocument"("cvVersionId");

-- CreateIndex
CREATE INDEX "GeneratedDocument_scoutRunId_idx" ON "GeneratedDocument"("scoutRunId");

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_jobOfferId_fkey" FOREIGN KEY ("jobOfferId") REFERENCES "JobOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_cvVersionId_fkey" FOREIGN KEY ("cvVersionId") REFERENCES "CVVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
