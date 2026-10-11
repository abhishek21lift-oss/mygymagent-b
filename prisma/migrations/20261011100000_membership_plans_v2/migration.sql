-- Additive, backward-compatible plan v2 fields. All nullable or
-- defaulted; existing rows keep today's semantics (no trial, no
-- offer, no fee, no tax, unlimited classes, no PT credits).
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "displayOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "trialDays" INTEGER;
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "compareAtPrice" DECIMAL(10,2);
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "joiningFee" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "taxMode" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "taxRate" DECIMAL(5,2);
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "weeklyClassLimit" INTEGER;
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "ptSessionCredits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "appointmentTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "termsAndConditions" TEXT;
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "faqs" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "membership_plans" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "isTrial" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "planSnapshot" JSONB;
