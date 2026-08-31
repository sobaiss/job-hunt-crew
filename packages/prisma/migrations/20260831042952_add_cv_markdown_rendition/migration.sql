-- CreateEnum
CREATE TYPE "CVConversionStatus" AS ENUM ('PENDING', 'CONVERTING', 'CONVERTED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CVFileType" ADD VALUE 'MD';
ALTER TYPE "CVFileType" ADD VALUE 'TXT';

-- AlterTable
ALTER TABLE "CVVersion" ADD COLUMN     "conversionError" TEXT,
ADD COLUMN     "conversionStatus" "CVConversionStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "markdownContent" TEXT;
