-- Ensure each member has at most one primary address and one primary
-- emergency contact. Existing duplicate primary rows are deterministically
-- demoted before the partial unique indexes are created.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "memberId"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    ) AS rn
  FROM member_addresses
  WHERE "isPrimary" = true
)
UPDATE member_addresses
SET "isPrimary" = false,
    "updatedAt" = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "memberId"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    ) AS rn
  FROM member_emergency_contacts
  WHERE "isPrimary" = true
)
UPDATE member_emergency_contacts
SET "isPrimary" = false,
    "updatedAt" = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS "member_addresses_one_primary_per_member"
  ON member_addresses ("memberId")
  WHERE "isPrimary" = true;

CREATE UNIQUE INDEX IF NOT EXISTS "member_emergency_contacts_one_primary_per_member"
  ON member_emergency_contacts ("memberId")
  WHERE "isPrimary" = true;
