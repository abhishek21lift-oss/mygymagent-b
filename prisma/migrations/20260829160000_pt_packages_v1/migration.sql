-- PT Packages v1
-- Package templates, member purchases, and an append-only session-consumption ledger.

CREATE TYPE "PtPackageStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'COMPLETED', 'CANCELLED');

CREATE TABLE "pt_package_templates" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "sessionCount" INTEGER NOT NULL,
  "validityDays" INTEGER NOT NULL,
  "price" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pt_package_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pt_package_templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pt_package_templates_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "pt_package_templates_organizationId_idx" ON "pt_package_templates"("organizationId");
CREATE INDEX "pt_package_templates_branchId_idx" ON "pt_package_templates"("branchId");

CREATE TABLE "pt_packages" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "templateId" TEXT,
  "name" TEXT NOT NULL,
  "totalSessions" INTEGER NOT NULL,
  "usedSessions" INTEGER NOT NULL DEFAULT 0,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "price" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "PtPackageStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pt_packages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pt_packages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pt_packages_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pt_packages_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pt_packages_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pt_package_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pt_packages_usedSessions_check" CHECK ("usedSessions" >= 0 AND "usedSessions" <= "totalSessions"),
  CONSTRAINT "pt_packages_totalSessions_check" CHECK ("totalSessions" > 0),
  CONSTRAINT "pt_packages_dates_check" CHECK ("endDate" >= "startDate")
);
CREATE INDEX "pt_packages_organizationId_memberId_status_idx" ON "pt_packages"("organizationId", "memberId", "status");
CREATE INDEX "pt_packages_organizationId_endDate_idx" ON "pt_packages"("organizationId", "endDate");

CREATE TABLE "pt_session_consumptions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "ptSessionId" TEXT NOT NULL,
  "sessions" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pt_session_consumptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pt_session_consumptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pt_session_consumptions_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "pt_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pt_session_consumptions_ptSessionId_fkey" FOREIGN KEY ("ptSessionId") REFERENCES "pt_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pt_session_consumptions_sessions_check" CHECK ("sessions" > 0),
  CONSTRAINT "pt_session_consumptions_package_session_unique" UNIQUE ("packageId", "ptSessionId")
);
CREATE INDEX "pt_session_consumptions_organizationId_idx" ON "pt_session_consumptions"("organizationId");
CREATE INDEX "pt_session_consumptions_ptSessionId_idx" ON "pt_session_consumptions"("ptSessionId");
