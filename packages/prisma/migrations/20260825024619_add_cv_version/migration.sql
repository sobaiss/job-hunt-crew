-- CreateEnum
CREATE TYPE "CVFileType" AS ENUM ('PDF', 'DOCX');

-- CreateEnum
CREATE TYPE "CVParseStatus" AS ENUM ('PENDING', 'PARSING', 'PARSED', 'FAILED');

-- CreateTable
CREATE TABLE "CVVersion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" "CVFileType" NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "parseStatus" "CVParseStatus" NOT NULL DEFAULT 'PENDING',
    "structuredData" JSONB,
    "structuredDataVer" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CVVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CVVersion_userId_idx" ON "CVVersion"("userId");

-- AddForeignKey
ALTER TABLE "CVVersion" ADD CONSTRAINT "CVVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
