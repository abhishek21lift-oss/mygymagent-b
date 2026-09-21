
CREATE TYPE "SalaryType" AS ENUM ('MONTHLY', 'DAILY', 'HOURLY');
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'APPROVED', 'PROCESSED', 'CANCELLED');
CREATE TYPE "PayrollItemStatus" AS ENUM ('PENDING', 'FINALIZED');
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "LeaveUnit" AS ENUM ('DAY', 'HALF_DAY');

ALTER TABLE "staff_profiles"
  ADD COLUMN "salaryType" "SalaryType",
  ADD COLUMN "baseSalary" DECIMAL(14,2),
  ADD COLUMN "hourlyRate" DECIMAL(14,2),
  ADD COLUMN "payrollEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "leave_types" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "paid" BOOLEAN NOT NULL DEFAULT true,
  "annualQuota" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "carryForward" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "leave_types_organizationId_code_key" ON "leave_types"("organizationId","code");
CREATE INDEX "leave_types_organizationId_active_idx" ON "leave_types"("organizationId","active");
CREATE INDEX "leave_types_branchId_idx" ON "leave_types"("branchId");

CREATE TABLE "leave_balances" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "staffProfileId" TEXT NOT NULL,
  "leaveTypeId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "opening" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "accrued" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "used" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "adjustment" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "closing" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "leave_balances_staffProfileId_leaveTypeId_year_key" ON "leave_balances"("staffProfileId","leaveTypeId","year");
CREATE INDEX "leave_balances_organizationId_year_idx" ON "leave_balances"("organizationId","year");

CREATE TABLE "leave_requests" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "staffProfileId" TEXT NOT NULL,
  "leaveTypeId" TEXT NOT NULL,
  "reviewedByUserId" TEXT,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "unit" "LeaveUnit" NOT NULL DEFAULT 'DAY',
  "days" DECIMAL(8,2) NOT NULL,
  "reason" TEXT,
  "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "leave_requests_organizationId_status_idx" ON "leave_requests"("organizationId","status");
CREATE INDEX "leave_requests_staffProfileId_startDate_idx" ON "leave_requests"("staffProfileId","startDate");
CREATE INDEX "leave_requests_branchId_startDate_idx" ON "leave_requests"("branchId","startDate");

CREATE TABLE "payroll_runs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "approvedByUserId" TEXT,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
  "approvedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payroll_runs_organizationId_branchId_periodStart_periodEnd_key" ON "payroll_runs"("organizationId","branchId","periodStart","periodEnd");
CREATE INDEX "payroll_runs_organizationId_status_idx" ON "payroll_runs"("organizationId","status");
CREATE INDEX "payroll_runs_branchId_periodStart_idx" ON "payroll_runs"("branchId","periodStart");

CREATE TABLE "payroll_items" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "payrollRunId" TEXT NOT NULL,
  "staffProfileId" TEXT NOT NULL,
  "baseSalary" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "overtime" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "incentives" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "deductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "unpaidLeave" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "gross" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "net" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "attendanceDays" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "payableDays" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "status" "PayrollItemStatus" NOT NULL DEFAULT 'PENDING',
  "notes" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payroll_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payroll_items_payrollRunId_staffProfileId_key" ON "payroll_items"("payrollRunId","staffProfileId");
CREATE INDEX "payroll_items_organizationId_staffProfileId_idx" ON "payroll_items"("organizationId","staffProfileId");

ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
