-- Additive, backward-compatible: optional contact fields for the Add Member enhancement.
-- No backfill, no defaults, no destructive changes.
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "alternatePhone" TEXT;
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "emergencyContactEmail" TEXT;
ALTER TABLE "member_emergency_contacts" ADD COLUMN IF NOT EXISTS "email" TEXT;
