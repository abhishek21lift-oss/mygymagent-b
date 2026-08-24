ALTER TABLE "workout_sessions" ADD COLUMN "branch_id" TEXT;

UPDATE "workout_sessions" ws
SET "branch_id" = m."primaryBranchId"
FROM "members" m
WHERE m."id" = ws."member_id" AND ws."branch_id" IS NULL;

ALTER TABLE "workout_sessions"
  ALTER COLUMN "branch_id" SET NOT NULL,
  ADD CONSTRAINT "workout_sessions_branch_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;

CREATE INDEX "workout_sessions_org_branch_date_idx" ON "workout_sessions" ("organization_id", "branch_id", "session_date");
