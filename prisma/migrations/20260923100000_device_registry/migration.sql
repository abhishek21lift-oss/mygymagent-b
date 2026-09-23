-- B-P0-13: retire `branches.deviceKey` in favour of the per-device,
-- hash-only registry in `kiosk_devices`.
--
-- The old column was one plaintext secret shared by every scanner on a
-- branch: it could not be rotated for a single device, revoking it locked
-- out the whole branch, and it sat in the row unhashed. It also had no
-- write path anywhere in the API -- `POST /branches/:id/rotate-device-key`
-- was called by the branches page and had never existed server-side -- so
-- in practice the column is NULL everywhere and the turnstile route could
-- not authenticate at all. The backfill below is written for the case
-- where it isn't, so a tenant that seeded a key directly keeps working.

CREATE TYPE "DeviceKind" AS ENUM ('KIOSK', 'BIOMETRIC');

ALTER TABLE kiosk_devices
  ADD COLUMN kind "DeviceKind" NOT NULL DEFAULT 'KIOSK',
  ADD COLUMN revoked_at timestamptz;

-- Existing rows are all kiosks (the table had no other producer), so the
-- DEFAULT above is already correct for them.

CREATE INDEX IF NOT EXISTS "kiosk_devices_organization_id_branch_id_idx"
  ON kiosk_devices (organization_id, branch_id);

-- One migrated device per branch that carries a key. `encode(sha256(...))`
-- matches the application's `sha256Hex` exactly (sha256 over the UTF-8
-- bytes, lower-case hex), so a scanner already configured with the branch
-- key keeps authenticating -- now as a named, revocable device.
INSERT INTO kiosk_devices (id, organization_id, branch_id, name, kind, key_hash, active, created_at)
SELECT
  gen_random_uuid()::text,
  b."organizationId",
  b.id,
  'Branch turnstile (migrated)',
  'BIOMETRIC',
  encode(sha256(b."deviceKey"::bytea), 'hex'),
  true,
  now()
FROM branches b
WHERE b."deviceKey" IS NOT NULL
  AND b."deletedAt" IS NULL
ON CONFLICT (key_hash) DO NOTHING;

DROP INDEX IF EXISTS "branches_deviceKey_key";
ALTER TABLE branches DROP COLUMN IF EXISTS "deviceKey";
