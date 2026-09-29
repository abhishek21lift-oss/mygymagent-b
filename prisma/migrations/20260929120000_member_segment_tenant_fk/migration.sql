-- Give `member_segment_assignments` the tenant column every other member
-- sub-table has had all along.
--
-- `MemberTagAssignment`, `MemberFollowUp`, `MemberDocument` and the rest
-- all carry `organizationId` with a real foreign key. This one did not,
-- so a query against it had to reach the tenant by joining through
-- `member` -- and a query that forgot to would return another gym's
-- segment membership. The column makes the tenant part of the row, so
-- scoping is the default shape rather than something each caller has to
-- remember.
--
-- Nothing has ever INSERTED into this table: the only statement that
-- touches it anywhere in the codebase is
-- `segments.service.ts`'s `deleteMany` when a segment is deleted.
-- Segment membership is otherwise computed on the fly. So this is a
-- schema-consistency fix rather than a fix for observed data corruption,
-- and retiring the table outright is a reasonable separate call.
--
-- EVERY STATEMENT IS IDEMPOTENT, for the reason B-P0-12a recorded: a
-- migration must converge from whatever state the target database is
-- actually in, not only from the state the history describes.

-- 1. Nullable first, so adding the column cannot fail on a table that
--    already has rows.
ALTER TABLE "member_segment_assignments"
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- 2. Backfill from the member. `memberId` has a foreign key with
--    ON DELETE CASCADE, so every existing row has a member and the
--    backfill is total; the WHERE simply avoids re-stamping rows that
--    were already repaired by an earlier partial run.
UPDATE "member_segment_assignments" AS msa
SET "organizationId" = m."organizationId"
FROM "members" AS m
WHERE msa."memberId" = m."id"
  AND msa."organizationId" IS NULL;

-- 3. Now that every row is stamped, the column is required. This is the
--    statement that would legitimately fail on real data, so it names the
--    offending rows rather than emitting a bare 23502.
DO $$
DECLARE
  unstamped BIGINT;
BEGIN
  SELECT COUNT(*) INTO unstamped
  FROM "member_segment_assignments"
  WHERE "organizationId" IS NULL;

  IF unstamped > 0 THEN
    RAISE EXCEPTION
      'member_segment_assignments has % row(s) with no organizationId; they reference a member that no longer exists. Inspect SELECT * FROM member_segment_assignments WHERE "organizationId" IS NULL before retrying.',
      unstamped;
  END IF;
END $$;

ALTER TABLE "member_segment_assignments"
  ALTER COLUMN "organizationId" SET NOT NULL;

-- 4. The foreign key, replacing any partial version rather than skipping
--    it if one is already present with a different definition.
ALTER TABLE "member_segment_assignments"
  DROP CONSTRAINT IF EXISTS "member_segment_assignments_organizationId_fkey",
  ADD CONSTRAINT "member_segment_assignments_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. The index that makes the scoped query above cheap, and matches the
--    sibling tables.
CREATE INDEX IF NOT EXISTS "member_segment_assignments_organizationId_segmentId_idx"
  ON "member_segment_assignments"("organizationId", "segmentId");
