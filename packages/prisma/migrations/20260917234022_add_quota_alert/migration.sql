-- CreateEnum
CREATE TYPE "QuotaAlertThreshold" AS ENUM ('APPROACHING', 'EXCEEDED');

-- CreateTable
CREATE TABLE "QuotaAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "quotaKind" "QuotaKind" NOT NULL,
    "threshold" "QuotaAlertThreshold" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "QuotaAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuotaAlert_userId_idx" ON "QuotaAlert"("userId");

-- AddForeignKey
ALTER TABLE "QuotaAlert" ADD CONSTRAINT "QuotaAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
