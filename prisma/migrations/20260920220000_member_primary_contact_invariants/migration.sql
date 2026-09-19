-- Keep at most one primary address/contact per member before adding
-- database-enforced uniqueness. Existing duplicates are preserved; only the
-- newest row remains primary.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY member_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM member_addresses
  WHERE is_primary = true
)
UPDATE member_addresses
SET is_primary = false
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY member_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM member_emergency_contacts
  WHERE is_primary = true
)
UPDATE member_emergency_contacts
SET is_primary = false
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX "member_addresses_one_primary_per_member"
  ON member_addresses (member_id)
  WHERE is_primary = true;

CREATE UNIQUE INDEX "member_emergency_contacts_one_primary_per_member"
  ON member_emergency_contacts (member_id)
  WHERE is_primary = true;
