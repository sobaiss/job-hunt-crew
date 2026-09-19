-- Reinstates `free`'s PlanQuotaDefault to its original #135 seed values,
-- reversing the unlimited-on-every-kind state the 20260918130000 migration
-- left it in ("Free is free") as an undocumented side effect (docs/adr/0021).
-- STANDARD and PREMIUM were never touched by that migration and are left
-- alone here too.
UPDATE "PlanQuotaDefault" SET "limit" = 2 WHERE "plan" = 'FREE' AND "quotaKind" = 'ACTIVE_SCOUTS';
UPDATE "PlanQuotaDefault" SET "limit" = 15 WHERE "plan" = 'FREE' AND "quotaKind" = 'ANALYSES_DAILY';
UPDATE "PlanQuotaDefault" SET "limit" = 300 WHERE "plan" = 'FREE' AND "quotaKind" = 'ANALYSES_MONTHLY';
UPDATE "PlanQuotaDefault" SET "limit" = 5 WHERE "plan" = 'FREE' AND "quotaKind" = 'DOCUMENTS_DAILY';
