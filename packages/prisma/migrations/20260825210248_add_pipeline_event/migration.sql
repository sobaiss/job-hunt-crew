-- CreateTable
CREATE TABLE "PipelineEvent" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT,
    "ingestionJobId" TEXT,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PipelineEvent_analysisId_idx" ON "PipelineEvent"("analysisId");

-- CreateIndex
CREATE INDEX "PipelineEvent_ingestionJobId_idx" ON "PipelineEvent"("ingestionJobId");

-- AddForeignKey
ALTER TABLE "PipelineEvent" ADD CONSTRAINT "PipelineEvent_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineEvent" ADD CONSTRAINT "PipelineEvent_ingestionJobId_fkey" FOREIGN KEY ("ingestionJobId") REFERENCES "IngestionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
