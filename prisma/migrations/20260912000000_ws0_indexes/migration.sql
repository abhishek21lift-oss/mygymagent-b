-- WS0 missing indexes: hot-path filters already in the Prisma schema
-- (Member org+status / email / phone, Lead org+branch, User org+status).
-- The pt_packages tables from 20260829160000_pt_packages_v1 already exist
-- in the database, so they are NOT recreated here -- only the new indexes.
CREATE INDEX IF NOT EXISTS "members_organizationId_status_idx" ON "members"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "members_email_idx" ON "members"("email");
CREATE INDEX IF NOT EXISTS "members_phone_idx" ON "members"("phone");
CREATE INDEX IF NOT EXISTS "leads_organizationId_branchId_idx" ON "leads"("organizationId", "branchId");
CREATE INDEX IF NOT EXISTS "users_organizationId_status_idx" ON "users"("organizationId", "status");
