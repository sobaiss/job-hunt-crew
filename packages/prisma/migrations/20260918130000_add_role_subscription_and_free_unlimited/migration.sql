-- Foundation for issue #151: Role (docs/adr/0017) and Subscription/Effective
-- Plan (docs/adr/0018). Every current reader of User.plan/isAdmin is left
-- untouched by this migration -- it only adds new, additively-backfilled
-- state alongside them. See issue #153.

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('EXTERNAL', 'INTERNAL', 'ADMINISTRATOR');

-- CreateEnum
CREATE TYPE "Duration" AS ENUM ('MONTHLY', 'YEARLY');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "role" "Role" NOT NULL DEFAULT 'EXTERNAL';

-- Backfill: ADMINISTRATOR where isAdmin was true, else EXTERNAL (the
-- column default) -- nobody is backfilled INTERNAL.
UPDATE "User" SET "role" = 'ADMINISTRATOR' WHERE "isAdmin" = true;

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" "Plan" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "duration" "Duration",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subscription_userId_idx" ON "Subscription"("userId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one Subscription per existing User matching their current
-- `plan` at migration time -- unbounded `free` for FREE, a one-year
-- `yearly` Subscription for STANDARD/PREMIUM starting now (docs/adr/0018).
-- No existing User is on ADMINISTRATEUR any more (#144 already migrated
-- every such User to PREMIUM + isAdmin), so no case is needed for it here.
INSERT INTO "Subscription" ("id", "userId", "plan", "startDate", "endDate", "duration", "createdAt")
SELECT
    gen_random_uuid()::text,
    "id",
    "plan",
    CURRENT_TIMESTAMP,
    CASE WHEN "plan" = 'FREE' THEN NULL ELSE CURRENT_TIMESTAMP + INTERVAL '1 year' END,
    CASE WHEN "plan" = 'FREE' THEN NULL ELSE 'YEARLY'::"Duration" END,
    CURRENT_TIMESTAMP
FROM "User";

-- `free` becomes unlimited across every QuotaKind (docs/adr/0018) -- the
-- "Free is free" product decision, now that Effective Plan derivation
-- (py_db.quotas.effective_plan) backs effective_quota.
UPDATE "PlanQuotaDefault" SET "limit" = NULL WHERE "plan" = 'FREE';
