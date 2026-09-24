-- B-P0-12: close the *substantive* gap between the migration history and
-- `schema.prisma`.
--
-- The drift was 475 lines. Most of it was cosmetic -- constraint and index
-- names, `ON UPDATE` clauses, `gen_random_uuid()` defaults that the raw DDL
-- wrote and Prisma's model syntax did not describe -- and that part is
-- resolved by annotating the schema to match the physical tables, which
-- executes no DDL and therefore risks nothing.
--
-- What is left is this file: places where the two genuinely disagreed, each
-- of which is a real defect rather than a naming mismatch.
--
-- EVERY STATEMENT BELOW IS IDEMPOTENT, and that is not politeness -- it is
-- the whole lesson of this migration. The first version assumed the target
-- database matched the migration history, because that is what B-P0-12
-- verified: `migrate diff` against a database *built from the migrations*.
-- Production had drifted from that history in the other direction as well
-- (`trainer_availability_rules` existed there, created out of band, most
-- likely by a `prisma db push`), so `CREATE TABLE` aborted the deploy and
-- took the service down with it. A migration that reconciles drift must
-- assume it is running against a database nobody has an accurate model of,
-- and converge to the intended state from wherever it actually starts.

-- 1. `AutomationKey` is missing a value the code already writes.
--    `src/automation/scanners/pt-expiry.scanner.ts` calls
--    `runs.attempt(org, 'PT_EXPIRY_REMINDER', ...)`. The enum in every
--    database has seven values and this is not one of them, so that
--    scanner throws on its first write.
ALTER TYPE "AutomationKey" ADD VALUE IF NOT EXISTS 'PT_EXPIRY_REMINDER';

-- 2. Two tables the schema declares and no migration ever created.
--    `appointments.service.ts` calls `prisma.trainerAvailabilityRule` and
--    `prisma.trainerTimeOff` in thirteen places -- `GET/POST/DELETE
--    /appointments/availability`, the same for `time-off`, and `free-slots`
--    -- against relations that exist in no migration. There is no e2e suite
--    for the appointments module, which is why nothing caught it.
CREATE TABLE IF NOT EXISTS "trainer_availability_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "branchId" TEXT,
    "dayOfWeek" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trainer_availability_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "trainer_time_offs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "branchId" TEXT,
    "reason" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trainer_time_offs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "trainer_availability_rules_organizationId_staffId_dayOfWeek_idx"
  ON "trainer_availability_rules"("organizationId", "staffId", "dayOfWeek");
CREATE INDEX IF NOT EXISTS "trainer_time_offs_organizationId_staffId_startAt_idx"
  ON "trainer_time_offs"("organizationId", "staffId", "startAt");

-- `ADD CONSTRAINT` has no IF NOT EXISTS, so each one drops first. That also
-- repairs a constraint that exists with the wrong definition, which is the
-- point: converge, do not assume.
ALTER TABLE "trainer_availability_rules"
  DROP CONSTRAINT IF EXISTS "trainer_availability_rules_organizationId_fkey",
  ADD CONSTRAINT "trainer_availability_rules_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trainer_availability_rules"
  DROP CONSTRAINT IF EXISTS "trainer_availability_rules_staffId_fkey",
  ADD CONSTRAINT "trainer_availability_rules_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "trainer_time_offs"
  DROP CONSTRAINT IF EXISTS "trainer_time_offs_organizationId_fkey",
  ADD CONSTRAINT "trainer_time_offs_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trainer_time_offs"
  DROP CONSTRAINT IF EXISTS "trainer_time_offs_staffId_fkey",
  ADD CONSTRAINT "trainer_time_offs_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. `member_tag_assignments` has no foreign keys at all. The schema
--    declares four, with cascades; the table was created without them, so
--    an assignment can outlive the member or the tag it points at and
--    nothing in the database says otherwise. Orphans are cleared first or
--    the constraints cannot be added.
DELETE FROM "member_tag_assignments" a
  WHERE NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = a."organizationId")
     OR NOT EXISTS (SELECT 1 FROM "members" m WHERE m.id = a."memberId")
     OR NOT EXISTS (SELECT 1 FROM "member_tags" t WHERE t.id = a."tagId");
UPDATE "member_tag_assignments" a SET "assignedByUserId" = NULL
  WHERE a."assignedByUserId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = a."assignedByUserId");

ALTER TABLE "member_tag_assignments"
  DROP CONSTRAINT IF EXISTS "member_tag_assignments_organizationId_fkey",
  ADD CONSTRAINT "member_tag_assignments_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_tag_assignments"
  DROP CONSTRAINT IF EXISTS "member_tag_assignments_memberId_fkey",
  ADD CONSTRAINT "member_tag_assignments_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_tag_assignments"
  DROP CONSTRAINT IF EXISTS "member_tag_assignments_tagId_fkey",
  ADD CONSTRAINT "member_tag_assignments_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "member_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_tag_assignments"
  DROP CONSTRAINT IF EXISTS "member_tag_assignments_assignedByUserId_fkey",
  ADD CONSTRAINT "member_tag_assignments_assignedByUserId_fkey"
    FOREIGN KEY ("assignedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. `payments`, where the disagreement is the most expensive.
--
--    a) `branchId` is NOT NULL with ON DELETE CASCADE in the database, and
--       nullable with ON DELETE SET NULL in the schema. As built, deleting
--       a branch deletes its payment records -- financial history -- where
--       the model says the reference should simply be cleared.
ALTER TABLE "payments" ALTER COLUMN "branchId" DROP NOT NULL;
ALTER TABLE "payments"
  DROP CONSTRAINT IF EXISTS "payments_branchId_fkey",
  ADD CONSTRAINT "payments_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

--    b) `stripePaymentIntentId` is `@unique` in the schema, and the
--       migration that added the column
--       (20260906000000_add_stripe_payment_intent_id) never created the
--       index. So the one thing that stops a replayed Stripe webhook from
--       recording the same payment twice does not exist.
--
--       This is the one statement that can legitimately fail on real data,
--       so it fails loudly and says exactly what to fix rather than
--       surfacing as a bare 23505. Merging duplicate payments is a business
--       decision, not something a migration may do silently.
DO $$
DECLARE dupes text;
BEGIN
  -- The inner quotes matter: an unquoted argument is case-folded, and this
  -- index name carries capitals, so to_regclass would look for
  -- "payments_stripepaymentintentid_key", never find it, and try to create
  -- an index that already exists.
  IF to_regclass('public."payments_stripePaymentIntentId_key"') IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT string_agg(t."stripePaymentIntentId", ', ')
    INTO dupes
    FROM (
      SELECT "stripePaymentIntentId"
        FROM "payments"
       WHERE "stripePaymentIntentId" IS NOT NULL
       GROUP BY "stripePaymentIntentId"
      HAVING count(*) > 1
       LIMIT 20
    ) t;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot make payments.stripePaymentIntentId unique: these intent ids appear on more than one payment row (%). Each duplicate is a Stripe payment recorded twice. Decide which row is authoritative, remove or re-key the others, then re-run this migration.', dupes;
  END IF;

  CREATE UNIQUE INDEX "payments_stripePaymentIntentId_key"
    ON "payments"("stripePaymentIntentId");
END $$;

--    c) The schema's payment indexes are organization-scoped; the physical
--       ones are not, so every lookup scans across tenants. Create the
--       scoped ones and drop the two they subsume.
CREATE INDEX IF NOT EXISTS "payments_organizationId_createdAt_idx"
  ON "payments"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "payments_organizationId_memberId_createdAt_idx"
  ON "payments"("organizationId", "memberId", "createdAt");
CREATE INDEX IF NOT EXISTS "payments_organizationId_membershipId_idx"
  ON "payments"("organizationId", "membershipId");
DROP INDEX IF EXISTS "payments_memberId_createdAt_idx";
DROP INDEX IF EXISTS "payments_membershipId_idx";
