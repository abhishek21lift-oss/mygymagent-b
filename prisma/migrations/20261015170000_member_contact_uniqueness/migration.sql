-- D-DB02 (F-DB02) enforcement: per-organization contact uniqueness for
-- live members, expressed with Prisma-native columns so the schema drift
-- gate keeps working (the B-P0-12 lesson rules out partial/expression
-- indexes that schema.prisma cannot describe).
--
-- `emailKey` / `phoneKey` carry the identity a member competes on while
-- live: the lowercased email, and the last-ten-digit handset key (the
-- same suffix comparison `assertContactUnique` makes; shorter numbers
-- key on all of their digits). Soft-deleted rows carry NULL keys -- in
-- Postgres NULLs do not collide -- so a rejoining member reuses their
-- old contact freely, matching the service's documented contract.
--
-- Triaged 2026-10-15 against production (956 live members, 2 orgs:
-- 0 duplicate email groups, 0 duplicate phone-key groups) and both local
-- databases; writers and backfill agree on the predicates.

ALTER TABLE "members" ADD COLUMN "emailKey" TEXT;
ALTER TABLE "members" ADD COLUMN "phoneKey" TEXT;

-- Writers already lowercase emails; converge legacy rows so the stored
-- value and the key agree.
UPDATE "members"
SET "email" = lower(btrim("email"))
WHERE "email" IS NOT NULL AND "email" <> lower(btrim("email"));

-- Live rows get their identity keys. Soft-deleted rows keep their raw
-- contact (history) but hold no identity slot.
UPDATE "members"
SET
  "emailKey" = NULLIF(lower(btrim("email")), ''),
  "phoneKey" = NULLIF(right(regexp_replace("phone", '\D', '', 'g'), 10), '')
WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "members_organizationId_emailKey_key" ON "members"("organizationId", "emailKey");
CREATE UNIQUE INDEX "members_organizationId_phoneKey_key" ON "members"("organizationId", "phoneKey");
