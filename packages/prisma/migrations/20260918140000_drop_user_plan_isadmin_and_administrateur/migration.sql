-- Issue #157: closes out the #151 expand-contract sequence. #155 moved every
-- reader of User.plan onto Subscription/Effective Plan and #156 moved every
-- reader of User.isAdmin onto Role -- both legacy columns, and the vestigial
-- ADMINISTRATEUR Plan value (unused since #144/docs/adr/0015), are dropped.

-- DropColumn
ALTER TABLE "User" DROP COLUMN "plan";
ALTER TABLE "User" DROP COLUMN "isAdmin";

-- Postgres has no `ALTER TYPE ... DROP VALUE`, so removing ADMINISTRATEUR
-- means recreating the enum: rename the old type out of the way, create the
-- replacement, repoint every remaining column (Subscription.plan,
-- PlanQuotaDefault.plan) at it, then drop the old type. No row anywhere is
-- currently ADMINISTRATEUR (PlanQuotaDefault's rows were removed in #144;
-- Subscription never accepted it), so no data-loss case exists to migrate.
ALTER TYPE "Plan" RENAME TO "Plan_old";

CREATE TYPE "Plan" AS ENUM ('FREE', 'STANDARD', 'PREMIUM');

ALTER TABLE "Subscription" ALTER COLUMN "plan" TYPE "Plan" USING ("plan"::text::"Plan");
ALTER TABLE "PlanQuotaDefault" ALTER COLUMN "plan" TYPE "Plan" USING ("plan"::text::"Plan");

DROP TYPE "Plan_old";
