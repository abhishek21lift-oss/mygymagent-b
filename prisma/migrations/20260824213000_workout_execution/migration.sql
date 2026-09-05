-- Workout execution layer: tenant-scoped sessions, exercise snapshots, and set logs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE "WorkoutSessionStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "workout_sessions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" TEXT NOT NULL,
  "assignment_id" TEXT NOT NULL,
  "member_id" TEXT NOT NULL,
  "session_date" DATE NOT NULL DEFAULT CURRENT_DATE,
  "status" "WorkoutSessionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completed_at" TIMESTAMPTZ,
  "notes" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "workout_sessions_assignment_fk" FOREIGN KEY ("assignment_id") REFERENCES "workout_assignments"("id") ON DELETE CASCADE,
  CONSTRAINT "workout_sessions_member_fk" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE,
  CONSTRAINT "workout_sessions_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "workout_sessions_assignment_day_unique" UNIQUE ("assignment_id", "session_date")
);

CREATE INDEX "workout_sessions_org_date_idx" ON "workout_sessions" ("organization_id", "session_date");
CREATE INDEX "workout_sessions_org_member_date_idx" ON "workout_sessions" ("organization_id", "member_id", "session_date");
CREATE INDEX "workout_sessions_assignment_idx" ON "workout_sessions" ("assignment_id");

CREATE TABLE "workout_session_exercises" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" TEXT NOT NULL,
  "session_id" UUID NOT NULL,
  "exercise_id" TEXT,
  "exercise_name" TEXT NOT NULL,
  "sets_target" INTEGER,
  "reps_target" TEXT,
  "rest_seconds" INTEGER,
  "display_order" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "workout_session_exercises_session_fk" FOREIGN KEY ("session_id") REFERENCES "workout_sessions"("id") ON DELETE CASCADE,
  CONSTRAINT "workout_session_exercises_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE INDEX "workout_session_exercises_session_idx" ON "workout_session_exercises" ("session_id", "display_order");
CREATE INDEX "workout_session_exercises_org_idx" ON "workout_session_exercises" ("organization_id");

CREATE TABLE "workout_set_logs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" TEXT NOT NULL,
  "session_id" UUID NOT NULL,
  "session_exercise_id" UUID NOT NULL,
  "set_number" INTEGER NOT NULL,
  "weight_kg" DECIMAL(8,2),
  "reps" INTEGER,
  "rpe" DECIMAL(3,1),
  "notes" TEXT,
  "completed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "workout_set_logs_session_fk" FOREIGN KEY ("session_id") REFERENCES "workout_sessions"("id") ON DELETE CASCADE,
  CONSTRAINT "workout_set_logs_exercise_fk" FOREIGN KEY ("session_exercise_id") REFERENCES "workout_session_exercises"("id") ON DELETE CASCADE,
  CONSTRAINT "workout_set_logs_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "workout_set_logs_set_unique" UNIQUE ("session_exercise_id", "set_number"),
  CONSTRAINT "workout_set_logs_positive_set" CHECK ("set_number" > 0),
  CONSTRAINT "workout_set_logs_nonnegative_weight" CHECK ("weight_kg" IS NULL OR "weight_kg" >= 0),
  CONSTRAINT "workout_set_logs_positive_reps" CHECK ("reps" IS NULL OR "reps" > 0),
  CONSTRAINT "workout_set_logs_rpe_range" CHECK ("rpe" IS NULL OR ("rpe" >= 0 AND "rpe" <= 10))
);

CREATE INDEX "workout_set_logs_org_session_idx" ON "workout_set_logs" ("organization_id", "session_id");
CREATE INDEX "workout_set_logs_exercise_idx" ON "workout_set_logs" ("session_exercise_id");
