CREATE TYPE "ClassProgramStatus" AS ENUM ('ACTIVE','INACTIVE');
CREATE TYPE "ClassBookingStatus" AS ENUM ('WAITLISTED','BOOKED','CANCELLED','ATTENDED','NO_SHOW');

CREATE TABLE "class_programs" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(), "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL, "description" TEXT, "capacity" INTEGER NOT NULL, "durationMinutes" INTEGER NOT NULL,
  "instructorId" TEXT, "status" "ClassProgramStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "class_programs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "class_programs_org_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "class_programs_branch_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE,
  CONSTRAINT "class_programs_instructor_fkey" FOREIGN KEY ("instructorId") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "class_programs_capacity_check" CHECK ("capacity" > 0),
  CONSTRAINT "class_programs_duration_check" CHECK ("durationMinutes" > 0)
);
CREATE TABLE "class_sessions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(), "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "classProgramId" TEXT NOT NULL, "instructorId" TEXT, "startTime" TIMESTAMP(3) NOT NULL, "endTime" TIMESTAMP(3) NOT NULL,
  "capacity" INTEGER, "status" "ClassProgramStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "class_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "class_sessions_org_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "class_sessions_branch_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE,
  CONSTRAINT "class_sessions_program_fkey" FOREIGN KEY ("classProgramId") REFERENCES "class_programs"("id") ON DELETE CASCADE,
  CONSTRAINT "class_sessions_instructor_fkey" FOREIGN KEY ("instructorId") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "class_sessions_time_check" CHECK ("startTime" < "endTime"),
  CONSTRAINT "class_sessions_capacity_check" CHECK ("capacity" IS NULL OR "capacity" > 0)
);
CREATE TABLE "class_bookings" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(), "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL, "memberId" TEXT NOT NULL, "status" "ClassBookingStatus" NOT NULL DEFAULT 'BOOKED',
  "waitlistPosition" INTEGER, "bookedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "cancelledAt" TIMESTAMP(3),
  "attendanceAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "class_bookings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "class_bookings_org_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "class_bookings_branch_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE,
  CONSTRAINT "class_bookings_session_fkey" FOREIGN KEY ("sessionId") REFERENCES "class_sessions"("id") ON DELETE CASCADE,
  CONSTRAINT "class_bookings_member_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE,
  CONSTRAINT "class_bookings_waitlist_check" CHECK ("waitlistPosition" IS NULL OR "waitlistPosition" > 0),
  CONSTRAINT "class_bookings_unique_member_session" UNIQUE ("sessionId","memberId")
);
CREATE INDEX "class_programs_org_branch_idx" ON "class_programs"("organizationId","branchId","status");
CREATE INDEX "class_sessions_org_start_idx" ON "class_sessions"("organizationId","startTime");
CREATE INDEX "class_sessions_org_branch_start_idx" ON "class_sessions"("organizationId","branchId","startTime");
CREATE INDEX "class_bookings_org_session_status_idx" ON "class_bookings"("organizationId","sessionId","status");
CREATE INDEX "class_bookings_org_member_idx" ON "class_bookings"("organizationId","memberId");