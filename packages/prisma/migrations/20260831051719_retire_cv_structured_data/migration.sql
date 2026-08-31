/*
  Warnings:

  - You are about to drop the column `parseStatus` on the `CVVersion` table. All the data in the column will be lost.
  - You are about to drop the column `structuredData` on the `CVVersion` table. All the data in the column will be lost.
  - You are about to drop the column `structuredDataVer` on the `CVVersion` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "CVVersion" DROP COLUMN "parseStatus",
DROP COLUMN "structuredData",
DROP COLUMN "structuredDataVer";

-- DropEnum
DROP TYPE "CVParseStatus";
