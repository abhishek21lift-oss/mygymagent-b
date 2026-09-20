CREATE TABLE "trainer_commission_rules" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL,
  "trainerId" TEXT NOT NULL,
  "percentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "fixedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "sessionType" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "trainer_commission_rules_organizationId_trainerId_idx" ON "trainer_commission_rules"("organizationId","trainerId");

CREATE TABLE "trainer_commissions" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL,
  "trainerId" TEXT NOT NULL,
  "ptSessionId" TEXT NOT NULL,
  "sessionAt" TIMESTAMP(3) NOT NULL,
  "baseAmount" DECIMAL(10,2) NOT NULL,
  "rate" DECIMAL(5,2) NOT NULL,
  "commissionAmount" DECIMAL(10,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trainer_commissions_org_session_key" UNIQUE ("organizationId","ptSessionId")
);
CREATE INDEX "trainer_commissions_organizationId_sessionAt_idx" ON "trainer_commissions"("organizationId","sessionAt");
CREATE INDEX "trainer_commissions_organizationId_trainerId_idx" ON "trainer_commissions"("organizationId","trainerId");

CREATE TABLE "payroll_periods" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "payroll_periods_organizationId_startDate_idx" ON "payroll_periods"("organizationId","startDate");

CREATE TABLE "subscription_plans" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "key" TEXT UNIQUE NOT NULL,
  "name" TEXT NOT NULL,
  "maxMembers" INTEGER,
  "maxBranches" INTEGER,
  "maxStaff" INTEGER,
  "aiMonthlyRequests" INTEGER,
  "storageMb" INTEGER,
  "whatsappMonthly" INTEGER,
  "apiMonthlyCalls" INTEGER,
  "priceMinor" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "organization_subscriptions" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT UNIQUE NOT NULL,
  "planId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "currentPeriodStart" TIMESTAMP(3) NOT NULL,
  "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "organization_subscriptions_planId_idx" ON "organization_subscriptions"("planId");

CREATE TABLE "platform_invoices" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL,
  "planId" TEXT,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "platform_invoices_organizationId_periodStart_idx" ON "platform_invoices"("organizationId","periodStart");

INSERT INTO subscription_plans ("key","name","maxMembers","maxBranches","maxStaff","aiMonthlyRequests","storageMb","whatsappMonthly","apiMonthlyCalls","priceMinor","currency","sortOrder","updatedAt")
VALUES
('trial','Free Trial',100,1,5,1000,1024,500,10000,0,'INR',0,now()),
('starter','Starter',500,2,10,5000,5120,2500,50000,99900,'INR',1,now()),
('professional','Professional',2000,5,30,20000,20480,10000,200000,249900,'INR',2,now()),
('business','Business',10000,20,100,100000,102400,50000,1000000,499900,'INR',3,now())
ON CONFLICT ("key") DO NOTHING;
