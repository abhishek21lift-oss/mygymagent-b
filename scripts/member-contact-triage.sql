-- D-DB02 (F-DB02) duplicate-contact triage -- READ-ONLY, no writes.
--
-- Run against a scratch copy (never production directly):
--   psql "$SCRATCH_URL" -f scripts/member-contact-triage.sql
--
-- Reports per-organization duplicate normalized emails and phones among
-- live members, plus OTP-ambiguous suffix groups. Outputs counts and
-- member ids/codes only -- never raw emails or phone numbers.
-- A uniqueness migration must NOT be written until these groups are
-- triaged (staff merge via the member-duplicates preview/execute path).

-- Duplicate normalized emails per organization (live members only).
SELECT m."organizationId" AS "organizationId",
       count(*) AS "members",
       count(DISTINCT member_code_norm) AS "distinctEmails",
       array_agg(m.id) AS "memberIds"
FROM (
  SELECT id, "organizationId",
         lower(trim(email)) AS member_code_norm
  FROM members
  WHERE "deletedAt" IS NULL
    AND email IS NOT NULL
    AND btrim(email) <> ''
) m
GROUP BY m."organizationId", member_code_norm
HAVING count(*) > 1
ORDER BY count(*) DESC;

-- Duplicate digit-sequence phones per organization (live members only).
SELECT m."organizationId" AS "organizationId",
       count(*) AS "members",
       array_agg(m.id) AS "memberIds"
FROM (
  SELECT id, "organizationId",
         regexp_replace(phone, '\D', '', 'g') AS digits
  FROM members
  WHERE "deletedAt" IS NULL
    AND phone IS NOT NULL
    AND btrim(phone) <> ''
) m
WHERE m.digits <> ''
GROUP BY m."organizationId", m.digits
HAVING count(*) > 1
ORDER BY count(*) DESC;

-- Cross-organization shared suffixes (OTP fail-closed coupling surface):
-- same last-10-digit group held by members of more than one organization.
SELECT suffix,
       count(*) AS "members",
       count(DISTINCT "organizationId") AS "organizations",
       array_agg(id) AS "memberIds"
FROM (
  SELECT id, "organizationId",
         right(regexp_replace(phone, '\D', '', 'g'), 10) AS suffix
  FROM members
  WHERE "deletedAt" IS NULL
    AND phone IS NOT NULL
) m
WHERE length(suffix) = 10
GROUP BY suffix
HAVING count(DISTINCT "organizationId") > 1
ORDER BY count(*) DESC;
