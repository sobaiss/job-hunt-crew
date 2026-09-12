-- CreateEnum
CREATE TYPE "ScoutStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Scout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "cvVersionId" TEXT NOT NULL,
    "targetSiteKeys" JSONB NOT NULL,
    "filters" JSONB NOT NULL,
    "matchThreshold" INTEGER NOT NULL DEFAULT 70,
    "status" "ScoutStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Scout_userId_idx" ON "Scout"("userId");

-- CreateIndex
CREATE INDEX "Scout_cvVersionId_idx" ON "Scout"("cvVersionId");

-- AddForeignKey
ALTER TABLE "Scout" ADD CONSTRAINT "Scout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scout" ADD CONSTRAINT "Scout_cvVersionId_fkey" FOREIGN KEY ("cvVersionId") REFERENCES "CVVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
