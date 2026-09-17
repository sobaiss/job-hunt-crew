-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'STANDARD', 'PREMIUM', 'ADMINISTRATEUR');

-- CreateEnum
CREATE TYPE "QuotaKind" AS ENUM ('ACTIVE_SCOUTS', 'ANALYSES_DAILY', 'ANALYSES_MONTHLY', 'DOCUMENTS_DAILY');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "plan" "Plan" NOT NULL DEFAULT 'FREE';

-- CreateTable
CREATE TABLE "PlanQuotaDefault" (
    "id" TEXT NOT NULL,
    "plan" "Plan" NOT NULL,
    "quotaKind" "QuotaKind" NOT NULL,
    "limit" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanQuotaDefault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotaOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "quotaKind" "QuotaKind" NOT NULL,
    "limit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotaOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanQuotaDefault_plan_quotaKind_key" ON "PlanQuotaDefault"("plan", "quotaKind");

-- CreateIndex
CREATE UNIQUE INDEX "QuotaOverride_userId_quotaKind_key" ON "QuotaOverride"("userId", "quotaKind");

-- AddForeignKey
ALTER TABLE "QuotaOverride" ADD CONSTRAINT "QuotaOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed one PlanQuotaDefault row per (Plan, QuotaKind) pair with the agreed
-- starting numbers (issue #135 / docs/adr/0014). administrateur is unlimited
-- (NULL) on every QuotaKind.
INSERT INTO "PlanQuotaDefault" ("id", "plan", "quotaKind", "limit", "updatedAt") VALUES
    (gen_random_uuid()::text, 'FREE', 'ACTIVE_SCOUTS', 2, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'FREE', 'ANALYSES_DAILY', 15, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'FREE', 'ANALYSES_MONTHLY', 300, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'FREE', 'DOCUMENTS_DAILY', 5, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'STANDARD', 'ACTIVE_SCOUTS', 5, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'STANDARD', 'ANALYSES_DAILY', 50, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'STANDARD', 'ANALYSES_MONTHLY', 1000, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'STANDARD', 'DOCUMENTS_DAILY', 20, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'PREMIUM', 'ACTIVE_SCOUTS', 15, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'PREMIUM', 'ANALYSES_DAILY', 150, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'PREMIUM', 'ANALYSES_MONTHLY', 3000, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'PREMIUM', 'DOCUMENTS_DAILY', 60, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'ADMINISTRATEUR', 'ACTIVE_SCOUTS', NULL, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'ADMINISTRATEUR', 'ANALYSES_DAILY', NULL, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'ADMINISTRATEUR', 'ANALYSES_MONTHLY', NULL, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'ADMINISTRATEUR', 'DOCUMENTS_DAILY', NULL, CURRENT_TIMESTAMP);

-- Backfill every User row that exists at migration time to STANDARD, so no
-- pre-existing Candidate regresses to FREE's lower limits on launch day
-- (docs/adr/0014). The column's DEFAULT 'FREE' above only governs rows
-- inserted after this migration runs.
UPDATE "User" SET "plan" = 'STANDARD';
