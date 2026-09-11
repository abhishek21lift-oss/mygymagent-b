import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export interface Member360TimelineItem {
  id: string;
  type: string;
  timestamp: string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  actorName: string | null;
}

/**
 * Member 360 aggregations: the overview snapshot and the unified
 * timeline the Member 360 frontend renders. Every number traces back
 * to rows owned by the member's own sub-resources (memberships,
 * attendance, payments, PT sessions, assessments, goals, documents,
 * notes, consents, message logs, history tables) -- this service only
 * aggregates, using the same per-currency honesty as FinanceService
 * (outstanding computed per membership row, never summed across
 * currencies here since overview is single-member).
 *
 * Engagement score (0-100, documented so it never reads as a black
 * box): visits in the last 30 days x 10 (capped at 70) + recency bonus
 * (30 if last visit within 7 days, 15 within 14, 5 within 30, else 0).
 * Level: >=60 high, >=30 medium, else low.
 */
@Injectable()
export class Member360Service {
  constructor(private readonly prisma: PrismaService) {}

  private async requireMember(
    organizationId: string,
    memberId: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const member = await this.prisma.member.findFirst({
      where: {
        id: memberId,
        organizationId,
        deletedAt: null,
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
      include: {
        primaryBranch: { select: { id: true, name: true } },
        assignedTrainer: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  async getOverview(
    organizationId: string,
    memberId: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const member = await this.requireMember(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const days30Ago = new Date(now.getTime() - 30 * MS_PER_DAY);

    const [
      memberships,
      attendances,
      payments,
      refunds,
      ptSessions,
      latestMeasurement,
      activeGoals,
      latestScreening,
      packageRemaining,
    ] = await Promise.all([
      this.prisma.membership.findMany({
        where: { organizationId, memberId },
        orderBy: { createdAt: 'desc' },
        include: { membershipPlan: { select: { name: true } } },
      }),
      this.prisma.attendance.findMany({
        where: { organizationId, memberId },
        orderBy: { checkInAt: 'desc' },
        select: { checkInAt: true },
      }),
      this.prisma.payment.findMany({
        where: { organizationId, memberId, status: 'COMPLETED' },
        select: { amount: true, membershipId: true },
      }),
      this.prisma.refund.findMany({
        where: { organizationId, payment: { memberId } },
        select: { amount: true },
      }),
      this.prisma.ptSession.findMany({
        where: { organizationId, memberId },
        select: { status: true, startTime: true, price: true },
      }),
      this.prisma.memberMeasurement.findFirst({
        where: { organizationId, memberId },
        orderBy: { recordedAt: 'desc' },
        select: { weightKg: true, bodyFatPercent: true, recordedAt: true },
      }),
      this.prisma.memberGoal.count({
        where: { organizationId, memberId, status: 'ACTIVE' },
      }),
      this.prisma.memberScreening.findFirst({
        where: { organizationId, memberId },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true, flaggedForMedicalClearance: true },
      }),
      this.prisma.$queryRawUnsafe<{ remaining: number }[]>(
        `SELECT COALESCE(SUM(GREATEST("totalSessions" - "usedSessions", 0)), 0) AS "remaining" FROM "pt_packages" WHERE "organizationId" = $1 AND "memberId" = $2 AND "status" = 'ACTIVE'`,
        organizationId,
        memberId,
      ),
    ]);

    const current =
      memberships.find((m) => m.status === 'ACTIVE') ?? memberships[0] ?? null;

    let membershipBlock: {
      id: string;
      planName: string;
      status: string;
      startDate: string;
      endDate: string;
      price: string;
      currency: string;
      autoRenew: boolean;
      totalPaid: string;
      outstandingBalance: string;
    } | null = null;
    if (current) {
      const paidForCurrent = payments
        .filter((p) => p.membershipId === current.id)
        .reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
      membershipBlock = {
        id: current.id,
        planName: current.membershipPlan.name,
        status: current.status,
        startDate: current.startDate.toISOString(),
        endDate: current.endDate.toISOString(),
        price: current.price.toFixed(2),
        currency: current.currency,
        autoRenew: current.autoRenew,
        totalPaid: paidForCurrent.toFixed(2),
        outstandingBalance: current.price.sub(paidForCurrent).toFixed(2),
      };
    }

    const dayKeys = [
      ...new Set(
        attendances.map((a) => startOfUtcDay(a.checkInAt).toISOString()),
      ),
    ].sort();
    const daySet = new Set(dayKeys);
    let streak = 0;
    const cursor = startOfUtcDay(now);
    if (!daySet.has(cursor.toISOString())) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    while (daySet.has(cursor.toISOString())) {
      streak += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }

    const lastVisit = attendances[0]?.checkInAt ?? null;
    const daysSinceLastVisit = lastVisit
      ? Math.floor((now.getTime() - lastVisit.getTime()) / MS_PER_DAY)
      : null;
    const visits30 = attendances.filter((a) => a.checkInAt >= days30Ago).length;
    const recencyBonus =
      daysSinceLastVisit === null
        ? 0
        : daysSinceLastVisit <= 7
          ? 30
          : daysSinceLastVisit <= 14
            ? 15
            : daysSinceLastVisit <= 30
              ? 5
              : 0;
    const score = Math.min(100, Math.min(visits30 * 10, 70) + recencyBonus);

    const totalPaid = payments.reduce(
      (sum, p) => sum.plus(p.amount),
      new Prisma.Decimal(0),
    );
    const totalRefunded = refunds.reduce(
      (sum, r) => sum.plus(r.amount),
      new Prisma.Decimal(0),
    );
    const totalDue = memberships.reduce(
      (sum, m) => sum.plus(m.price),
      new Prisma.Decimal(0),
    );

    const completed = ptSessions.filter((s) => s.status === 'COMPLETED');
    const ptRevenue = completed.reduce(
      (sum, s) => sum.plus(s.price ?? new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    );

    return {
      member: {
        id: member.id,
        memberCode: member.memberCode,
        firstName: member.firstName,
        lastName: member.lastName,
        email: member.email,
        phone: member.phone,
        dateOfBirth: toIso(member.dateOfBirth),
        gender: member.gender,
        memberType: member.memberType,
        status: member.status,
        joinedAt: member.joinedAt.toISOString(),
        addressLine1: member.addressLine1,
        city: member.city,
        state: member.state,
        postalCode: member.postalCode,
        country: member.country,
        emergencyContactName: member.emergencyContactName,
        emergencyContactPhone: member.emergencyContactPhone,
        notes: member.notes,
        assignedTrainerId: member.assignedTrainerId,
        primaryBranchId: member.primaryBranchId,
        primaryBranch: member.primaryBranch,
        assignedTrainer: member.assignedTrainer,
      },
      membership: membershipBlock,
      attendance: {
        thisMonth: attendances.filter((a) => a.checkInAt >= monthStart).length,
        last30Days: visits30,
        totalVisits: attendances.length,
        currentStreak: streak,
        lastVisit: toIso(lastVisit),
      },
      engagement: {
        score,
        level: (score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low') as
          'low' | 'medium' | 'high',
        lastActivityAt: toIso(lastVisit),
        daysSinceLastVisit,
      },
      finance: {
        totalPaid: totalPaid.toFixed(2),
        totalRefunded: totalRefunded.toFixed(2),
        outstandingBalance: totalDue.sub(totalPaid).toFixed(2),
        pendingPayments: 0,
      },
      ptSummary: {
        totalSessions: ptSessions.length,
        completedSessions: completed.length,
        cancelledSessions: ptSessions.filter((s) => s.status === 'CANCELLED')
          .length,
        upcomingSessions: ptSessions.filter(
          (s) => s.status === 'SCHEDULED' && s.startTime >= now,
        ).length,
        remainingPackageSessions: Number(packageRemaining[0]?.remaining ?? 0),
        totalRevenue: ptRevenue.toFixed(2),
      },
      latestAssessment: latestMeasurement
        ? {
            weightKg: latestMeasurement.weightKg?.toFixed(2) ?? null,
            bodyFatPercent:
              latestMeasurement.bodyFatPercent?.toFixed(2) ?? null,
            recordedAt: latestMeasurement.recordedAt.toISOString(),
          }
        : null,
      activeGoals,
      latestScreening: latestScreening
        ? {
            completedAt: latestScreening.completedAt.toISOString(),
            flaggedForMedicalClearance:
              latestScreening.flaggedForMedicalClearance,
          }
        : null,
    };
  }

  async getTimeline(
    organizationId: string,
    memberId: string,
    page = 1,
    pageSize = 50,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const member = await this.requireMember(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const events: Member360TimelineItem[] = [];
    const actor = (u: { firstName: string; lastName: string } | null) =>
      u ? `${u.firstName} ${u.lastName}` : null;

    events.push({
      id: `member-${member.id}`,
      type: 'member_created',
      timestamp: member.joinedAt.toISOString(),
      title: 'Member joined',
      description: null,
      metadata: {},
      actorName: null,
    });

    const [
      statusHistory,
      branchHistory,
      trainerHistory,
      memberships,
      attendances,
      payments,
      refunds,
      ptSessions,
      assessments,
      measurements,
      fitnessTests,
      screenings,
      goals,
      documents,
      notes,
      consents,
      messages,
    ] = await Promise.all([
      this.prisma.memberStatusHistory.findMany({
        where: { organizationId, memberId },
        include: {
          changedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.memberBranchHistory.findMany({
        where: { organizationId, memberId },
        include: {
          toBranch: { select: { name: true } },
          changedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.memberTrainerHistory.findMany({
        where: { organizationId, memberId },
        include: {
          toTrainer: { select: { firstName: true, lastName: true } },
          changedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.membership.findMany({
        where: { organizationId, memberId },
        include: { membershipPlan: { select: { name: true } } },
      }),
      this.prisma.attendance.findMany({
        where: { organizationId, memberId },
        orderBy: { checkInAt: 'desc' },
        take: 100,
      }),
      this.prisma.payment.findMany({
        where: { organizationId, memberId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.refund.findMany({
        where: { organizationId, payment: { memberId } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.ptSession.findMany({
        where: { organizationId, memberId },
        orderBy: { startTime: 'desc' },
        take: 100,
      }),
      this.prisma.memberAssessment.findMany({
        where: { organizationId, memberId },
        orderBy: { conductedAt: 'desc' },
        take: 20,
        include: {
          conductedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.memberMeasurement.findMany({
        where: { organizationId, memberId },
        orderBy: { recordedAt: 'desc' },
        take: 20,
      }),
      this.prisma.memberFitnessTestResult.findMany({
        where: { organizationId, memberId },
        orderBy: { recordedAt: 'desc' },
        take: 20,
      }),
      this.prisma.memberScreening.findMany({
        where: { organizationId, memberId },
        orderBy: { completedAt: 'desc' },
        take: 20,
      }),
      this.prisma.memberGoal.findMany({
        where: { organizationId, memberId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.memberDocument.findMany({
        where: { organizationId, memberId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.memberNote.findMany({
        where: { organizationId, memberId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          authorUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.memberConsent.findMany({
        where: { organizationId, memberId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.messageLog.findMany({
        where: { organizationId, memberId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    for (const h of statusHistory)
      events.push({
        id: h.id,
        type: 'status_changed',
        timestamp: h.createdAt.toISOString(),
        title: `Status changed to ${h.toStatus}`,
        description: h.reason,
        metadata: { fromStatus: h.fromStatus, toStatus: h.toStatus },
        actorName: actor(h.changedByUser),
      });
    for (const h of branchHistory)
      events.push({
        id: h.id,
        type: 'branch_changed',
        timestamp: h.createdAt.toISOString(),
        title: `Moved to ${h.toBranch.name}`,
        description: h.reason,
        metadata: {},
        actorName: actor(h.changedByUser),
      });
    for (const h of trainerHistory)
      events.push({
        id: h.id,
        type: 'trainer_changed',
        timestamp: h.createdAt.toISOString(),
        title: h.toTrainer
          ? `Assigned to ${actor(h.toTrainer)}`
          : 'Trainer unassigned',
        description: h.reason,
        metadata: {},
        actorName: actor(h.changedByUser),
      });
    for (const m of memberships) {
      events.push({
        id: `membership-${m.id}`,
        type:
          m.previousMembershipId !== null
            ? 'membership_renewed'
            : 'membership_started',
        timestamp: m.startDate.toISOString(),
        title: `${m.previousMembershipId !== null ? 'Renewed' : 'Started'} ${m.membershipPlan.name}`,
        description: null,
        metadata: { status: m.status, membershipId: m.id },
        actorName: null,
      });
      if (m.status === 'CANCELLED')
        events.push({
          id: `membership-cancelled-${m.id}`,
          type: 'membership_cancelled',
          timestamp: (m.cancelledAt ?? m.updatedAt).toISOString(),
          title: `Cancelled ${m.membershipPlan.name}`,
          description: m.cancellationReason,
          metadata: { membershipId: m.id },
          actorName: null,
        });
      if (m.status === 'FROZEN')
        events.push({
          id: `membership-frozen-${m.id}`,
          type: 'membership_frozen',
          timestamp: m.updatedAt.toISOString(),
          title: `Frozen ${m.membershipPlan.name}`,
          description: null,
          metadata: { membershipId: m.id },
          actorName: null,
        });
      if (m.status === 'EXPIRED')
        events.push({
          id: `membership-expired-${m.id}`,
          type: 'membership_expired',
          timestamp: m.endDate.toISOString(),
          title: `Expired ${m.membershipPlan.name}`,
          description: null,
          metadata: { membershipId: m.id },
          actorName: null,
        });
    }
    for (const a of attendances) {
      events.push({
        id: `checkin-${a.id}`,
        type: 'attendance_checkin',
        timestamp: a.checkInAt.toISOString(),
        title: 'Checked in',
        description: null,
        metadata: { attendanceId: a.id },
        actorName: null,
      });
      if (a.checkOutAt)
        events.push({
          id: `checkout-${a.id}`,
          type: 'attendance_checkout',
          timestamp: a.checkOutAt.toISOString(),
          title: 'Checked out',
          description: null,
          metadata: { attendanceId: a.id },
          actorName: null,
        });
    }
    for (const p of payments)
      events.push({
        id: `payment-${p.id}`,
        type: 'payment_received',
        timestamp: p.createdAt.toISOString(),
        title: `Payment of ${p.amount.toFixed(2)} ${p.currency}`,
        description: p.note,
        metadata: { paymentId: p.id, status: p.status },
        actorName: null,
      });
    for (const r of refunds)
      events.push({
        id: `refund-${r.id}`,
        type: 'refund_issued',
        timestamp: r.createdAt.toISOString(),
        title: `Refund of ${r.amount.toFixed(2)}`,
        description: r.reason,
        metadata: { refundId: r.id },
        actorName: null,
      });
    for (const s of ptSessions)
      events.push({
        id: `pt-${s.id}`,
        type:
          s.status === 'COMPLETED'
            ? 'pt_session_completed'
            : s.status === 'CANCELLED'
              ? 'pt_session_cancelled'
              : s.status === 'NO_SHOW'
                ? 'pt_session_no_show'
                : 'pt_session_scheduled',
        timestamp: s.startTime.toISOString(),
        title: `PT session ${s.status.toLowerCase().replace('_', ' ')}`,
        description: s.notes,
        metadata: { ptSessionId: s.id },
        actorName: null,
      });
    for (const a of assessments)
      events.push({
        id: `assessment-${a.id}`,
        type: 'assessment_completed',
        timestamp: a.conductedAt.toISOString(),
        title: `Assessment (${a.type})`,
        description: a.notes,
        metadata: {},
        actorName: actor(a.conductedByUser),
      });
    for (const m of measurements)
      events.push({
        id: `measurement-${m.id}`,
        type: 'measurement_recorded',
        timestamp: m.recordedAt.toISOString(),
        title: 'Body measurements recorded',
        description: m.notes,
        metadata: {},
        actorName: null,
      });
    for (const f of fitnessTests)
      events.push({
        id: `fitnesstest-${f.id}`,
        type: 'fitness_test_recorded',
        timestamp: f.recordedAt.toISOString(),
        title: `${f.testName}: ${f.value.toFixed(2)} ${f.unit}`,
        description: f.notes,
        metadata: {},
        actorName: null,
      });
    for (const s of screenings)
      events.push({
        id: `screening-${s.id}`,
        type: 'screening_completed',
        timestamp: s.completedAt.toISOString(),
        title: 'Health screening completed',
        description: s.notes,
        metadata: { flaggedForMedicalClearance: s.flaggedForMedicalClearance },
        actorName: null,
      });
    for (const g of goals)
      events.push({
        id: `goal-${g.id}`,
        type:
          g.status === 'ACHIEVED'
            ? 'goal_achieved'
            : g.status === 'PAUSED'
              ? 'goal_paused'
              : g.status === 'ABANDONED'
                ? 'goal_abandoned'
                : 'goal_created',
        timestamp: (g.achievedAt ?? g.createdAt).toISOString(),
        title: `${g.status === 'ACTIVE' ? 'Goal set' : `Goal ${g.status.toLowerCase()}`}: ${g.title}`,
        description: g.description,
        metadata: { goalId: g.id },
        actorName: null,
      });
    for (const d of documents)
      events.push({
        id: `document-${d.id}`,
        type: 'document_uploaded',
        timestamp: d.createdAt.toISOString(),
        title: `Document uploaded (${d.category})`,
        description: d.description,
        metadata: { documentId: d.id },
        actorName: null,
      });
    for (const n of notes)
      events.push({
        id: `note-${n.id}`,
        type: 'note_added',
        timestamp: n.createdAt.toISOString(),
        title: 'Note added',
        description: n.body.slice(0, 200),
        metadata: { noteId: n.id },
        actorName: actor(n.authorUser),
      });
    for (const c of consents)
      events.push({
        id: `consent-${c.id}`,
        type: 'consent_recorded',
        timestamp: c.createdAt.toISOString(),
        title: `${c.type} consent ${c.granted ? 'granted' : 'revoked'}`,
        description: c.note,
        metadata: {},
        actorName: null,
      });
    for (const m of messages)
      events.push({
        id: `message-${m.id}`,
        type: 'message_sent',
        timestamp: m.createdAt.toISOString(),
        title: `${m.channel} message ${m.status.toLowerCase()}`,
        description: null,
        metadata: { messageLogId: m.id, channel: m.channel },
        actorName: null,
      });

    events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

    const safePage = Math.max(1, page);
    const safePageSize = Math.min(Math.max(1, pageSize), 200);
    const start = (safePage - 1) * safePageSize;
    return {
      events: events.slice(start, start + safePageSize),
      totalCount: events.length,
      page: safePage,
      pageSize: safePageSize,
    };
  }
}
