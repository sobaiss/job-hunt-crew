-- Decouples admin access from Plan (docs/adr/0015) and adds per-request
-- blocking enforcement (docs/adr/0016). See issue #144.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "blockedAt" TIMESTAMP(3);

-- Every User previously on the ADMINISTRATEUR Plan keeps admin access via
-- isAdmin, but moves to a real quota tier. The Plan enum value itself is
-- left in place (no ALTER TYPE ... DROP VALUE) -- just never assigned again.
UPDATE "User" SET "isAdmin" = true, "plan" = 'PREMIUM' WHERE "plan" = 'ADMINISTRATEUR';

-- ADMINISTRATEUR's PlanQuotaDefault rows are meaningless once no User is
-- ever assigned that Plan again.
DELETE FROM "PlanQuotaDefault" WHERE "plan" = 'ADMINISTRATEUR';

-- RenameTable
ALTER TABLE "QuotaAuditEvent" RENAME TO "AdminAuditEvent";
