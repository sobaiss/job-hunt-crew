-- CreateEnum
CREATE TYPE "CVStyleStatus" AS ENUM ('PENDING', 'EXTRACTED', 'NOT_APPLICABLE', 'FAILED');

-- AlterTable
ALTER TABLE "CVVersion" ADD COLUMN     "styleProfile" JSONB,
ADD COLUMN     "styleStatus" "CVStyleStatus";
