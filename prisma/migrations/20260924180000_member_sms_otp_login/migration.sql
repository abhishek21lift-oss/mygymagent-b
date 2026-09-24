-- SMS OTP login for members.
--
-- Two changes, both widening, neither destructive:
--
-- 1. `users.email` becomes nullable. A member identified by their phone
--    has no email to be identified by, and on this deployment that is
--    947 of 954 members -- the Customer Enquiry export carried phone
--    numbers and almost no addresses. Postgres permits many NULLs under
--    a unique index, so the constraint still binds everyone who has one.
--
-- 2. `member_otp_challenges` holds an issued code. Only its sha256 is
--    stored, like every other credential in this schema.
--
-- Every statement is idempotent, per the lesson of
-- 20260923120000_reconcile_schema_drift: a migration that assumes the
-- target matches the history is one out-of-band change away from
-- aborting the deploy and taking the service down. DROP NOT NULL on an
-- already-nullable column is a no-op rather than an error, so this file
-- converges whether or not it has run before.

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

CREATE TABLE IF NOT EXISTS "member_otp_challenges" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_otp_challenges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "member_otp_challenges_phone_createdAt_idx"
    ON "member_otp_challenges"("phone", "createdAt");

CREATE INDEX IF NOT EXISTS "member_otp_challenges_memberId_idx"
    ON "member_otp_challenges"("memberId");

-- Dropped and re-added in one statement so a constraint that exists with
-- the wrong definition is repaired rather than skipped.
ALTER TABLE "member_otp_challenges"
    DROP CONSTRAINT IF EXISTS "member_otp_challenges_memberId_fkey",
    ADD CONSTRAINT "member_otp_challenges_memberId_fkey"
        FOREIGN KEY ("memberId") REFERENCES "members"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
