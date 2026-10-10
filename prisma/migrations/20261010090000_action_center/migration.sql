-- Daily Action Center: worklist tasks and their history, the call log,
-- payment promises and AI proposals from call notes. New tables and enums
-- only; nothing existing is altered.
-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TaskCategory" AS ENUM ('CALL', 'PAYMENT_FOLLOW_UP', 'PAYMENT_PROMISE', 'RENEWAL', 'LEAD_FOLLOW_UP', 'TRIAL', 'INACTIVE_MEMBER', 'PT_CONFIRMATION', 'COMPLAINT', 'FOLLOW_UP', 'GENERAL');

-- CreateEnum
CREATE TYPE "TaskSource" AS ENUM ('MANUAL', 'SYSTEM', 'AI_SUGGESTION');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('CONNECTED', 'NO_ANSWER', 'BUSY', 'CALL_BACK_REQUESTED', 'PAYMENT_PROMISED', 'PAYMENT_COMPLETED', 'NOT_INTERESTED', 'RENEWAL_INTERESTED', 'COMPLAINT_RAISED', 'WRONG_NUMBER', 'OTHER');

-- CreateEnum
CREATE TYPE "CallAnalysisStatus" AS ENUM ('NOT_REQUESTED', 'PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentPromiseStatus" AS ENUM ('OPEN', 'KEPT', 'BROKEN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActionProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ActionProposalKind" AS ENUM ('FOLLOW_UP_CALL', 'PAYMENT_PROMISE', 'RENEWAL_FOLLOW_UP', 'TRIAL_VISIT', 'MANAGER_ESCALATION', 'OTHER');

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "TaskCategory" NOT NULL DEFAULT 'GENERAL',
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "source" "TaskSource" NOT NULL DEFAULT 'MANUAL',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "memberId" TEXT,
    "leadId" TEXT,
    "assignedToUserId" TEXT,
    "createdByUserId" TEXT,
    "dedupeKey" TEXT,
    "reason" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "checklist" JSONB,
    "escalatedAt" TIMESTAMP(3),
    "escalatedByUserId" TEXT,
    "escalationReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "completionNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "memberId" TEXT,
    "leadId" TEXT,
    "phone" TEXT,
    "direction" "CallDirection" NOT NULL DEFAULT 'OUTBOUND',
    "calledAt" TIMESTAMP(3) NOT NULL,
    "outcome" "CallOutcome" NOT NULL,
    "reason" TEXT,
    "response" TEXT,
    "internalNotes" TEXT,
    "amountDiscussed" DECIMAL(12,2),
    "promisedPaymentDate" TIMESTAMP(3),
    "nextFollowUpAt" TIMESTAMP(3),
    "priority" "TaskPriority",
    "paymentId" TEXT,
    "taskId" TEXT,
    "recordedByUserId" TEXT,
    "assignedToUserId" TEXT,
    "editedAt" TIMESTAMP(3),
    "editedByUserId" TEXT,
    "analysisStatus" "CallAnalysisStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "analysis" JSONB,
    "analysisError" TEXT,
    "analysisAttempts" INTEGER NOT NULL DEFAULT 0,
    "analyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_promises" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "memberId" TEXT NOT NULL,
    "membershipId" TEXT,
    "callLogId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "promisedFor" TIMESTAMP(3) NOT NULL,
    "status" "PaymentPromiseStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedPaymentId" TEXT,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_promises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_proposals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "callLogId" TEXT NOT NULL,
    "memberId" TEXT,
    "leadId" TEXT,
    "kind" "ActionProposalKind" NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "explicit" BOOLEAN NOT NULL DEFAULT false,
    "evidence" TEXT,
    "suggestedDueAt" TIMESTAMP(3),
    "dueAtNeedsConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "suggestedPriority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "amount" DECIMAL(12,2),
    "status" "ActionProposalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_organizationId_status_dueAt_idx" ON "tasks"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_organizationId_assignedToUserId_status_dueAt_idx" ON "tasks"("organizationId", "assignedToUserId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_organizationId_branchId_status_dueAt_idx" ON "tasks"("organizationId", "branchId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_memberId_idx" ON "tasks"("memberId");

-- CreateIndex
CREATE INDEX "tasks_leadId_idx" ON "tasks"("leadId");

-- CreateIndex
CREATE INDEX "tasks_organizationId_sourceType_sourceId_idx" ON "tasks"("organizationId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_organizationId_dedupeKey_key" ON "tasks"("organizationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "task_events_taskId_createdAt_idx" ON "task_events"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "call_logs_organizationId_calledAt_idx" ON "call_logs"("organizationId", "calledAt");

-- CreateIndex
CREATE INDEX "call_logs_organizationId_memberId_calledAt_idx" ON "call_logs"("organizationId", "memberId", "calledAt");

-- CreateIndex
CREATE INDEX "call_logs_organizationId_leadId_calledAt_idx" ON "call_logs"("organizationId", "leadId", "calledAt");

-- CreateIndex
CREATE INDEX "call_logs_organizationId_analysisStatus_idx" ON "call_logs"("organizationId", "analysisStatus");

-- CreateIndex
CREATE INDEX "payment_promises_organizationId_status_promisedFor_idx" ON "payment_promises"("organizationId", "status", "promisedFor");

-- CreateIndex
CREATE INDEX "payment_promises_memberId_idx" ON "payment_promises"("memberId");

-- CreateIndex
CREATE INDEX "action_proposals_organizationId_status_createdAt_idx" ON "action_proposals"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "action_proposals_callLogId_idx" ON "action_proposals"("callLogId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_promises" ADD CONSTRAINT "payment_promises_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_promises" ADD CONSTRAINT "payment_promises_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_promises" ADD CONSTRAINT "payment_promises_callLogId_fkey" FOREIGN KEY ("callLogId") REFERENCES "call_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_callLogId_fkey" FOREIGN KEY ("callLogId") REFERENCES "call_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

