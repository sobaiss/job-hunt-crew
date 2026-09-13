-- AlterTable
ALTER TABLE "CVVersion" ADD COLUMN     "supersededById" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CVVersion_supersededById_key" ON "CVVersion"("supersededById");
