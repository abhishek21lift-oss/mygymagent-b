-- Ensure each member has at most one primary address and one primary
-- emergency contact. Existing duplicate primary rows are deterministically
-- demoted before the partial unique indexes are created.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY member_id
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS rn
  FROM member_addresses
  WHERE is_primary = true
)
UPDATE member_addresses
SET is_primary = false,
    updated_at = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY member_id
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS rn
  FROM member_emergency_contacts
  WHERE is_primary = true
)
UPDATE member_emergency_contacts
SET is_primary = false,
    updated_at = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS "member_addresses_one_primary_per_member"
  ON member_addresses (member_id)
  WHERE is_primary = true;

CREATE UNIQUE INDEX IF NOT EXISTS "member_emergency_contacts_one_primary_per_member"
  ON member_emergency_contacts (member_id)
  WHERE is_primary = true;
