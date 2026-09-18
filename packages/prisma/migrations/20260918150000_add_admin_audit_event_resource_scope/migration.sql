-- Issue #159: AdminAuditEvent needs to represent an Administrator acting on
-- a candidate's own resource (an Analysis, a Scout, or a CVVersion), not
-- just editing a scalar field on a User. Adds a nullable resourceType/
-- resourceId pair alongside the existing field/oldValue/newValue shape, so
-- one row shape covers both kinds of event through the same helper.

-- field becomes nullable: a resource-scoped event (#161/#162/#163) has no
-- field/oldValue/newValue to record, only resourceType/resourceId. No
-- existing row is affected -- every row written so far always set field.
ALTER TABLE "AdminAuditEvent" ALTER COLUMN "field" DROP NOT NULL;

ALTER TABLE "AdminAuditEvent" ADD COLUMN "resourceType" TEXT;
ALTER TABLE "AdminAuditEvent" ADD COLUMN "resourceId" TEXT;
