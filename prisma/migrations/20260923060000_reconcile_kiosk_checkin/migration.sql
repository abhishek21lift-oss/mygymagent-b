-- B-P0-5: reconcile the two device check-in systems onto one table of record.
--
-- `kiosk_events` was written by the Business OS kiosk endpoint and read by
-- nothing: a kiosk check-in never produced an `attendances` row, so it never
-- reached the live turnstile view, the attendance list, any report, or the
-- AttendanceRecorded domain event. Device attribution was the only thing
-- `kiosk_events` held that `attendances` did not, so that moves onto
-- `attendances` and the shadow table goes.

-- AlterTable: device attribution on the canonical record.
ALTER TABLE "attendances" ADD COLUMN "deviceId" TEXT;

ALTER TABLE "attendances"
  ADD CONSTRAINT "attendances_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "kiosk_devices"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "attendances_deviceId_checkInAt_idx" ON "attendances"("deviceId", "checkInAt");

-- Backfill: carry the kiosk history into `attendances` rather than losing
-- it. Only rows with a real member can become attendance records; a
-- `kiosk_events` row whose member_id went NULL (its member was deleted)
-- has nothing to attach to. `result` is the only signal the old table kept
-- about *why* entry was refused, so a denied row gets a marker rather than
-- a fabricated reason -- the original gate reason was never recorded.
INSERT INTO "attendances" (
  "id", "organizationId", "branchId", "memberId", "checkInAt", "method",
  "deniedReason", "deviceId", "createdAt"
)
SELECT
  gen_random_uuid()::text,
  e.organization_id,
  e.branch_id,
  e.member_id,
  e.created_at,
  'KIOSK'::"AttendanceMethod",
  CASE WHEN e.result = 'ALLOWED' THEN NULL
       ELSE 'denied at kiosk (reason not recorded before B-P0-5)' END,
  e.device_id,
  e.created_at
FROM kiosk_events e
WHERE e.member_id IS NOT NULL
  AND e.event_type = 'CHECK_IN'
  -- Idempotence guard: never double-count a check-in that somehow already
  -- reached `attendances`.
  AND NOT EXISTS (
    SELECT 1 FROM "attendances" a
    WHERE a."memberId" = e.member_id
      AND a."checkInAt" = e.created_at
      AND a."method" = 'KIOSK'::"AttendanceMethod"
  );

-- DropTable
DROP TABLE IF EXISTS kiosk_events;
