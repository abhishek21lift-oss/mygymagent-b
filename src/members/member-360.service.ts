import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';

export type TimelineEventType =
  | 'member_created'
  | 'status_changed'
  | 'branch_changed'
  | 'trainer_changed'
  | 'membership_started'
  | 'membership_renewed'
  | 'membership_frozen'
  | 'membership_resumed'
  | 'membership_cancelled'
  | 'membership_expired'
  | 'attendance_checkin'
  | 'attendance_checkout'
  | 'payment_received'
  | 'refund_issued'
  | 'pt_session_scheduled'
  | 'pt_session_completed'
  | 'pt_session_cancelled'
  | 'pt_session_no_show'
  | 'assessment_completed'
  | 'measurement_recorded'
  | 'fitness_test_recorded'
  | 'screening_completed'
  | 'goal_created'
  | 'goal_achieved'
  | 'goal_paused'
  | 'goal_abandoned'
  | 'document_uploaded'
  | 'note_added'
  | 'consent_recorded'
  | 'message_sent';

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  timestamp: string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  actorName: string | null;
}

export interface Member360Timeline {
  events: TimelineEvent[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface Member360Overview {
  member: {
    id: string;
    memberCode: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    memberType: string | null;
    status: string;
    joinedAt: string;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
    notes: string | null;
    assignedTrainerId: string | null;
    primaryBranchId: string;
    primaryBranch: { id: string; name: string };
    assignedTrainer: { id: string; firstName: string; lastName: string } | null;
  };
  membership: {
    id: string;
    planName: string;
    status: string;
    startDate: string;
    endDate: string;
    price: Prisma.Decimal;
    currency: string;
    autoRenew: boolean;
    totalPaid: Prisma.Decimal;
    outstandingBalance: Prisma.Decimal;
  } | null;
  attendance: {
    thisMonth: number;
    last30Days: number;
    totalVisits: number;
    currentStreak: number;
    lastVisit: string | null;
  };
  engagement: {
    score: number;
    level: 'low' | 'medium' | 'high';
    lastActivityAt: string | null;
    daysSinceLastVisit: number | null;
  };
  finance: {
    totalPaid: Prisma.Decimal;
    totalRefunded: Prisma.Decimal;
    outstandingBalance: Prisma.Decimal;
    pendingPayments: number;
  };
  ptSummary: {
    totalSessions: number;
    completedSessions: number;
    cancelledSessions: number;
    upcomingSessions: number;
    remainingPackageSessions: number | null;
    totalRevenue: Prisma.Decimal;
  };
  latestAssessment: {
    weightKg: string | null;
    bodyFatPercent: string | null;
    recordedAt: string | null;
  } | null;
  activeGoals: number;
  latestScreening: {
    completedAt: string | null;
    flaggedForMedicalClearance: boolean;
  } | null;
}

@Injectable()
export class Member360Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
  ) {}

  async getOverview(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<Member360Overview> {
    await this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const [
      member,
      memberships,
      attendance,
      payments,
      refunds,
      ptSessions,
      latestMeasurement,
      goals,
      latestScreening,
    ] = await Promise.all([
      this.prisma.member.findUnique({
        where: { id: memberId },
        select: {
          id: true,
          memberCode: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
          memberType: true,
          status: true,
          joinedAt: true,
          addressLine1: true,
          city: true,
          state: true,
          postalCode: true,
          country: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
          notes: true,
          assignedTrainerId: true,
          primaryBranchId: true,
          primaryBranch: { select: { id: true, name: true } },
          assignedTrainer: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.membership.findMany({
        where: { memberId, organizationId },
        orderBy: { createdAt: 'desc' },
        include: { membershipPlan: { select: { name: true } } },
      }),
      this.prisma.attendance.findMany({
        where: { memberId, organizationId },
        orderBy: { checkInAt: 'desc' },
      }),
      this.prisma.payment.findMany({
        where: {
          memberId,
          organizationId,
          status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED'] },
        },
      }),
      this.prisma.refund.findMany({
        where: {
          organizationId,
          payment: { memberId, organizationId },
        },
        include: { payment: { select: { memberId: true } } },
      }),
      this.prisma.ptSession.findMany({
        where: { memberId, organizationId },
      }),
      this.prisma.memberMeasurement.findFirst({
        where: { memberId, organizationId },
        orderBy: { recordedAt: 'desc' },
        select: { weightKg: true, bodyFatPercent: true, recordedAt: true },
      }),
      this.prisma.memberGoal.findMany({
        where: { memberId, organizationId, status: 'ACTIVE' },
      }),
      this.prisma.memberScreening.findFirst({
        where: { memberId, organizationId },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true, flaggedForMedicalClearance: true },
      }),
    ]);

    if (!member) {
      throw new Error('Member not found');
    }

    const activeMembership = memberships.find((m) => m.status === 'ACTIVE');
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const thisMonthAttendance = attendance.filter(
      (a) => new Date(a.checkInAt) >= thisMonthStart,
    ).length;
    const last30DaysAttendance = attendance.filter(
      (a) => new Date(a.checkInAt) >= thirtyDaysAgo,
    ).length;

    const currentStreak = this.calculateStreak(
      attendance.map((a) => a.checkInAt),
    );
    const lastVisit = attendance[0]?.checkInAt ?? null;

    const totalPaid = payments.reduce(
      (sum, p) => sum.plus(p.amount),
      new Prisma.Decimal(0),
    );
    const relevantRefunds = refunds.filter(
      (r) => r.payment?.memberId === memberId,
    );
    const totalRefunded = relevantRefunds.reduce(
      (sum, r) => sum.plus(r.amount),
      new Prisma.Decimal(0),
    );

    const membershipBalance = this.calculateMembershipBalance(
      memberships,
      payments,
    );
    const outstandingBalance = membershipBalance.totalDue
      .sub(totalPaid)
      .add(totalRefunded);

    const completedPtSessions = ptSessions.filter(
      (s) => s.status === 'COMPLETED',
    ).length;
    const cancelledPtSessions = ptSessions.filter(
      (s) => s.status === 'CANCELLED' || s.status === 'NO_SHOW',
    ).length;
    const upcomingPtSessions = ptSessions.filter(
      (s) => s.status === 'SCHEDULED',
    ).length;
    const ptRevenue = ptSessions
      .filter((s) => s.isPaid && s.price)
      .reduce((sum, s) => sum.plus(s.price!), new Prisma.Decimal(0));

    let remainingPackageSessions: number | null = null;
    try {
      const packageResult = await this.prisma.$queryRawUnsafe<
        { remaining: number }[]
      >(
        `SELECT GREATEST(p."totalSessions" - p."usedSessions", 0) AS remaining
         FROM "pt_packages" p
         WHERE p."memberId" = $1 AND p."organizationId" = $2 AND p.status = 'ACTIVE'
         ORDER BY p."endDate" ASC
         LIMIT 1`,
        memberId,
        organizationId,
      );
      if (packageResult[0]) {
        remainingPackageSessions = packageResult[0].remaining;
      }
    } catch {
      remainingPackageSessions = null;
    }

    const engagementScore = this.calculateEngagementScore(
      thisMonthAttendance,
      last30DaysAttendance,
      activeMembership?.status === 'ACTIVE',
      completedPtSessions,
    );

    const daysSinceLastVisit = lastVisit
      ? Math.floor(
          (now.getTime() - new Date(lastVisit).getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : null;

    return {
      member: {
        ...member,
        joinedAt: member.joinedAt.toISOString(),
        dateOfBirth: member.dateOfBirth?.toISOString() ?? null,
      } as Member360Overview['member'],
      membership: activeMembership
        ? {
            id: activeMembership.id,
            planName: activeMembership.membershipPlan.name,
            status: activeMembership.status,
            startDate: activeMembership.startDate.toISOString(),
            endDate: activeMembership.endDate.toISOString(),
            price: activeMembership.price,
            currency: activeMembership.currency,
            autoRenew: activeMembership.autoRenew,
            totalPaid: membershipBalance.totalPaidForMembership(
              activeMembership.id,
            ),
            outstandingBalance: membershipBalance.outstandingForMembership(
              activeMembership.id,
            ),
          }
        : null,
      attendance: {
        thisMonth: thisMonthAttendance,
        last30Days: last30DaysAttendance,
        totalVisits: attendance.length,
        currentStreak,
        lastVisit: lastVisit ? new Date(lastVisit).toISOString() : null,
      },
      engagement: {
        score: engagementScore,
        level:
          engagementScore >= 70
            ? 'high'
            : engagementScore >= 40
              ? 'medium'
              : 'low',
        lastActivityAt: lastVisit ? new Date(lastVisit).toISOString() : null,
        daysSinceLastVisit,
      },
      finance: {
        totalPaid,
        totalRefunded,
        outstandingBalance,
        pendingPayments: payments.filter(
          (p) =>
            p.status !== PaymentStatus.REFUNDED &&
            p.status !== PaymentStatus.FAILED,
        ).length,
      },
      ptSummary: {
        totalSessions: ptSessions.length,
        completedSessions: completedPtSessions,
        cancelledSessions: cancelledPtSessions,
        upcomingSessions: upcomingPtSessions,
        remainingPackageSessions,
        totalRevenue: ptRevenue,
      },
      latestAssessment: latestMeasurement
        ? {
            weightKg: latestMeasurement.weightKg?.toString() ?? null,
            bodyFatPercent:
              latestMeasurement.bodyFatPercent?.toString() ?? null,
            recordedAt: latestMeasurement.recordedAt?.toISOString() ?? null,
          }
        : null,
      activeGoals: goals.length,
      latestScreening: latestScreening
        ? {
            completedAt: latestScreening.completedAt?.toISOString() ?? null,
            flaggedForMedicalClearance:
              latestScreening.flaggedForMedicalClearance,
          }
        : null,
    };
  }

  private calculateStreak(dates: Date[]): number {
    if (!dates.length) return 0;

    const sorted = [...new Set(dates.map((d) => d.toDateString()))].sort(
      (a, b) => new Date(b).getTime() - new Date(a).getTime(),
    );

    let streak = 0;
    let current = new Date();

    for (const date of sorted) {
      const d = new Date(date);
      const diff = Math.floor(
        (current.getTime() - d.getTime()) / (24 * 60 * 60 * 1000),
      );
      if (diff <= 1) {
        streak++;
        current = d;
      } else {
        break;
      }
    }

    return streak;
  }

  private calculateEngagementScore(
    thisMonth: number,
    last30Days: number,
    hasActiveMembership: boolean,
    completedPtSessions: number,
  ): number {
    let score = 0;

    if (thisMonth >= 12) score += 30;
    else if (thisMonth >= 8) score += 20;
    else if (thisMonth >= 4) score += 10;
    else if (thisMonth >= 1) score += 5;

    if (last30Days >= 8) score += 25;
    else if (last30Days >= 4) score += 15;
    else if (last30Days >= 1) score += 5;

    if (hasActiveMembership) score += 25;

    if (completedPtSessions >= 8) score += 20;
    else if (completedPtSessions >= 4) score += 10;

    return Math.min(100, score);
  }

  private calculateMembershipBalance(
    memberships: Array<{
      id: string;
      price: Prisma.Decimal;
      discount?: Prisma.Decimal | null;
    }>,
    payments: Array<{
      membershipId: string | null;
      amount: Prisma.Decimal;
    }>,
  ) {
    const membershipIds = new Set(memberships.map((m) => m.id));

    const totalDue = memberships.reduce(
      (sum, m) => sum.plus(m.price.sub(m.discount ?? new Prisma.Decimal(0))),
      new Prisma.Decimal(0),
    );

    const totalPaid = payments
      .filter((p) => p.membershipId && membershipIds.has(p.membershipId))
      .reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));

    const outstandingBalance = totalDue.sub(totalPaid);

    return {
      totalDue,
      totalPaid,
      outstandingBalance,
      totalPaidForMembership: (membershipId: string) =>
        payments
          .filter((p) => p.membershipId === membershipId)
          .reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0)),
      outstandingForMembership: (membershipId: string) => {
        const m = memberships.find(
          (membership) => membership.id === membershipId,
        );
        if (!m) return new Prisma.Decimal(0);
        const due = m.price.sub(m.discount ?? new Prisma.Decimal(0));
        const paid = payments
          .filter((p) => p.membershipId === membershipId)
          .reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
        return due.sub(paid);
      },
    };
  }

  async getTimeline(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
    page: number = 1,
    pageSize: number = 50,
  ): Promise<Member360Timeline> {
    await this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const safePage = Math.max(1, page || 1);
    const safePageSize = Math.min(100, Math.max(1, pageSize || 50));
    const skip = (safePage - 1) * safePageSize;

    const [
      statusHistory,
      branchHistory,
      trainerHistory,
      memberships,
      attendance,
      payments,
      refunds,
      ptSessions,
      assessments,
      measurements,
      fitnessResults,
      screenings,
      goals,
      documents,
      notes,
      consents,
      messageLogs,
    ] = await Promise.all([
      this.prisma.memberStatusHistory.findMany({
        where: { organizationId, memberId },
        orderBy: { createdAt: 'desc' },
        include: {
          changedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.memberBranchHistory.findMany({
        where: { organizationId, memberId },
        orderBy: { createdAt: 'desc' },
        include: {
          fromBranch: { select: { name: true } },
          toBranch: { select: { name: true } },
          changedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.memberTrainerHistory.findMany({
        where: { organizationId, memberId },
        orderBy: { createdAt: 'desc' },
        include: {
          fromTrainer: { select: { firstName: true, lastName: true } },
          toTrainer: { select: { firstName: true, lastName: true } },
          changedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.membership.findMany({
        where: { memberId, organizationId },
        orderBy: { createdAt: 'desc' },
        include: {
          membershipPlan: { select: { name: true } },
          payments: { select: { id: true, amount: true, status: true } },
        },
      }),
      this.prisma.attendance.findMany({
        where: { memberId, organizationId },
        orderBy: { checkInAt: 'desc' },
        include: {
          branch: { select: { name: true } },
          recordedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.payment.findMany({
        where: { memberId, organizationId },
        orderBy: { createdAt: 'desc' },
        include: {
          recordedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.refund.findMany({
        where: {
          organizationId,
          payment: { memberId, organizationId },
        },
        include: {
          recordedByUser: { select: { firstName: true, lastName: true } },
          payment: { select: { memberId: true } },
        },
      }),
      this.prisma.ptSession.findMany({
        where: { memberId, organizationId },
        orderBy: { startTime: 'desc' },
        include: {
          trainer: {
            select: { user: { select: { firstName: true, lastName: true } } },
          },
          branch: { select: { name: true } },
        },
      }),
      this.prisma.memberAssessment.findMany({
        where: { memberId, organizationId },
        orderBy: { conductedAt: 'desc' },
        include: {
          conductedByUser: { select: { firstName: true, lastName: true } },
          measurements: true,
          fitnessResults: true,
          screening: true,
        },
      }),
      this.prisma.memberMeasurement.findMany({
        where: { memberId, organizationId },
        orderBy: { recordedAt: 'desc' },
        include: {
          recordedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.memberFitnessTestResult.findMany({
        where: { memberId, organizationId },
        orderBy: { recordedAt: 'desc' },
        include: {
          recordedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.memberScreening.findMany({
        where: { memberId, organizationId },
        orderBy: { completedAt: 'desc' },
        include: {
          recordedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.memberGoal.findMany({
        where: { memberId, organizationId },
        orderBy: { createdAt: 'desc' },
        include: {
          createdByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.memberDocument.findMany({
        where: { memberId, organizationId },
        orderBy: { createdAt: 'desc' },
        include: {
          versions: {
            include: { file: { select: { originalName: true } } },
            orderBy: { version: 'desc' },
            take: 1,
          },
        },
      }),
      this.prisma.memberNote.findMany({
        where: { memberId, organizationId },
        orderBy: { createdAt: 'desc' },
        include: {
          authorUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.memberConsent.findMany({
        where: { memberId, organizationId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.messageLog.findMany({
        where: { memberId, organizationId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const events: TimelineEvent[] = [];

    for (const history of statusHistory) {
      events.push({
        id: `status-${history.id}`,
        type: 'status_changed',
        timestamp: history.createdAt.toISOString(),
        title: history.fromStatus
          ? `Status changed: ${history.fromStatus} → ${history.toStatus}`
          : `Member status set to ${history.toStatus}`,
        description: history.reason ?? null,
        metadata: {
          fromStatus: history.fromStatus,
          toStatus: history.toStatus,
        },
        actorName: history.changedByUser
          ? `${history.changedByUser.firstName} ${history.changedByUser.lastName}`
          : null,
      });
    }

    for (const history of branchHistory) {
      events.push({
        id: `branch-${history.id}`,
        type: 'branch_changed',
        timestamp: history.createdAt.toISOString(),
        title: history.fromBranch
          ? `Branch changed: ${history.fromBranch.name} → ${history.toBranch.name}`
          : `Assigned to branch ${history.toBranch.name}`,
        description: history.reason ?? null,
        metadata: {
          fromBranchId: history.fromBranchId,
          fromBranchName: history.fromBranch?.name,
          toBranchId: history.toBranchId,
          toBranchName: history.toBranch.name,
        },
        actorName: history.changedByUser
          ? `${history.changedByUser.firstName} ${history.changedByUser.lastName}`
          : null,
      });
    }

    for (const history of trainerHistory) {
      const fromName = history.fromTrainer
        ? `${history.fromTrainer.firstName} ${history.fromTrainer.lastName}`
        : 'Unassigned';
      const toName = history.toTrainer
        ? `${history.toTrainer.firstName} ${history.toTrainer.lastName}`
        : 'Unassigned';
      events.push({
        id: `trainer-${history.id}`,
        type: 'trainer_changed',
        timestamp: history.createdAt.toISOString(),
        title:
          history.fromTrainer && history.toTrainer
            ? `Trainer changed: ${fromName} → ${toName}`
            : history.toTrainer
              ? `Trainer assigned: ${toName}`
              : `Trainer unassigned`,
        description: history.reason ?? null,
        metadata: {
          fromTrainerId: history.fromTrainerId,
          fromTrainerName: fromName,
          toTrainerId: history.toTrainerId,
          toTrainerName: toName,
        },
        actorName: history.changedByUser
          ? `${history.changedByUser.firstName} ${history.changedByUser.lastName}`
          : null,
      });
    }

    for (const membership of memberships) {
      const isRenewal = !!membership.previousMembershipId;

      events.push({
        id: `membership-${membership.id}`,
        type: isRenewal ? 'membership_renewed' : 'membership_started',
        timestamp: membership.createdAt.toISOString(),
        title: isRenewal
          ? `Membership renewed: ${membership.membershipPlan.name}`
          : `Membership started: ${membership.membershipPlan.name}`,
        description: `${membership.currency} ${membership.price} - ${membership.status}`,
        metadata: {
          membershipId: membership.id,
          planName: membership.membershipPlan.name,
          status: membership.status,
          startDate: membership.startDate.toISOString(),
          endDate: membership.endDate.toISOString(),
          autoRenew: membership.autoRenew,
        },
        actorName: null,
      });

      if (membership.status === 'FROZEN') {
        events.push({
          id: `membership-frozen-${membership.id}`,
          type: 'membership_frozen',
          timestamp: (
            membership.freezeStartDate ?? membership.updatedAt
          ).toISOString(),
          title: `Membership frozen: ${membership.membershipPlan.name}`,
          description: membership.totalFreezeDaysUsed
            ? `${membership.totalFreezeDaysUsed} freeze days used`
            : null,
          metadata: {
            membershipId: membership.id,
            freezeStartDate: membership.freezeStartDate?.toISOString() ?? null,
            freezeEndDate: membership.freezeEndDate?.toISOString() ?? null,
          },
          actorName: null,
        });
      }

      if (membership.status === 'CANCELLED') {
        events.push({
          id: `membership-cancelled-${membership.id}`,
          type: 'membership_cancelled',
          timestamp: (
            membership.cancelledAt ?? membership.updatedAt
          ).toISOString(),
          title: `Membership cancelled: ${membership.membershipPlan.name}`,
          description: membership.cancellationReason ?? null,
          metadata: {
            membershipId: membership.id,
            cancelledAt: membership.cancelledAt?.toISOString() ?? null,
            reason: membership.cancellationReason,
          },
          actorName: null,
        });
      }
    }

    for (const attendanceRecord of attendance) {
      events.push({
        id: `attendance-${attendanceRecord.id}`,
        type: 'attendance_checkin',
        timestamp: attendanceRecord.checkInAt.toISOString(),
        title: `Checked in at ${attendanceRecord.branch.name}`,
        description: `Method: ${attendanceRecord.method}`,
        metadata: {
          attendanceId: attendanceRecord.id,
          branchId: attendanceRecord.branchId,
          branchName: attendanceRecord.branch.name,
          method: attendanceRecord.method,
          checkInAt: attendanceRecord.checkInAt.toISOString(),
          checkOutAt: attendanceRecord.checkOutAt?.toISOString() ?? null,
        },
        actorName: attendanceRecord.recordedByUser
          ? `${attendanceRecord.recordedByUser.firstName} ${attendanceRecord.recordedByUser.lastName}`
          : null,
      });

      if (attendanceRecord.checkOutAt) {
        events.push({
          id: `attendance-checkout-${attendanceRecord.id}`,
          type: 'attendance_checkout',
          timestamp: attendanceRecord.checkOutAt.toISOString(),
          title: `Checked out from ${attendanceRecord.branch.name}`,
          description: null,
          metadata: {
            attendanceId: attendanceRecord.id,
            checkOutAt: attendanceRecord.checkOutAt.toISOString(),
          },
          actorName: null,
        });
      }
    }

    for (const payment of payments) {
      events.push({
        id: `payment-${payment.id}`,
        type: 'payment_received',
        timestamp: payment.createdAt.toISOString(),
        title: `Payment received: ${payment.currency} ${payment.amount}`,
        description: `${payment.method} - ${payment.status}`,
        metadata: {
          paymentId: payment.id,
          amount: payment.amount.toString(),
          currency: payment.currency,
          method: payment.method,
          status: payment.status,
        },
        actorName: payment.recordedByUser
          ? `${payment.recordedByUser.firstName} ${payment.recordedByUser.lastName}`
          : null,
      });
    }

    for (const refund of refunds) {
      if (refund.payment?.memberId !== memberId) continue;
      events.push({
        id: `refund-${refund.id}`,
        type: 'refund_issued',
        timestamp: refund.createdAt.toISOString(),
        title: `Refund issued: ${refund.amount}`,
        description: refund.reason ?? null,
        metadata: {
          refundId: refund.id,
          paymentId: refund.paymentId,
          amount: refund.amount.toString(),
        },
        actorName: refund.recordedByUser
          ? `${refund.recordedByUser.firstName} ${refund.recordedByUser.lastName}`
          : null,
      });
    }

    for (const session of ptSessions) {
      const trainerName = session.trainer
        ? `${session.trainer.user.firstName} ${session.trainer.user.lastName}`
        : null;

      if (session.status === 'SCHEDULED') {
        events.push({
          id: `pt-scheduled-${session.id}`,
          type: 'pt_session_scheduled',
          timestamp: session.createdAt.toISOString(),
          title: `PT session scheduled${trainerName ? ` with ${trainerName}` : ''}`,
          description: `At ${session.branch.name}`,
          metadata: {
            sessionId: session.id,
            trainerId: session.trainerId,
            trainerName,
            branchId: session.branchId,
            branchName: session.branch.name,
            startTime: session.startTime.toISOString(),
            endTime: session.endTime.toISOString(),
            type: session.type,
          },
          actorName: null,
        });
      } else if (session.status === 'COMPLETED') {
        events.push({
          id: `pt-completed-${session.id}`,
          type: 'pt_session_completed',
          timestamp: session.endTime.toISOString(),
          title: `PT session completed${trainerName ? ` with ${trainerName}` : ''}`,
          description: session.notes ?? null,
          metadata: {
            sessionId: session.id,
            trainerId: session.trainerId,
            trainerName,
            isPaid: session.isPaid,
            price: session.price?.toString() ?? null,
          },
          actorName: trainerName,
        });
      } else if (session.status === 'CANCELLED') {
        events.push({
          id: `pt-cancelled-${session.id}`,
          type: 'pt_session_cancelled',
          timestamp: session.updatedAt.toISOString(),
          title: `PT session cancelled${trainerName ? ` with ${trainerName}` : ''}`,
          description: session.notes ?? null,
          metadata: {
            sessionId: session.id,
            trainerId: session.trainerId,
            trainerName,
          },
          actorName: trainerName,
        });
      } else if (session.status === 'NO_SHOW') {
        events.push({
          id: `pt-no-show-${session.id}`,
          type: 'pt_session_no_show',
          timestamp: session.updatedAt.toISOString(),
          title: `PT session no-show${trainerName ? ` with ${trainerName}` : ''}`,
          description: null,
          metadata: {
            sessionId: session.id,
            trainerId: session.trainerId,
            trainerName,
          },
          actorName: trainerName,
        });
      }
    }

    for (const assessment of assessments) {
      events.push({
        id: `assessment-${assessment.id}`,
        type: 'assessment_completed',
        timestamp: assessment.conductedAt.toISOString(),
        title: `Assessment completed: ${assessment.type}`,
        description: assessment.notes ?? null,
        metadata: {
          assessmentId: assessment.id,
          type: assessment.type,
          measurementCount: assessment.measurements.length,
          fitnessResultCount: assessment.fitnessResults.length,
          hasScreening: !!assessment.screening,
        },
        actorName: assessment.conductedByUser
          ? `${assessment.conductedByUser.firstName} ${assessment.conductedByUser.lastName}`
          : null,
      });
    }

    for (const measurement of measurements) {
      const parts: string[] = [];
      if (measurement.weightKg) parts.push(`Weight: ${measurement.weightKg}kg`);
      if (measurement.bodyFatPercent)
        parts.push(`Body fat: ${measurement.bodyFatPercent}%`);

      events.push({
        id: `measurement-${measurement.id}`,
        type: 'measurement_recorded',
        timestamp: measurement.recordedAt.toISOString(),
        title: 'Measurement recorded',
        description: parts.join(' | ') || null,
        metadata: {
          measurementId: measurement.id,
          weightKg: measurement.weightKg?.toString() ?? null,
          bodyFatPercent: measurement.bodyFatPercent?.toString() ?? null,
        },
        actorName: measurement.recordedByUser
          ? `${measurement.recordedByUser.firstName} ${measurement.recordedByUser.lastName}`
          : null,
      });
    }

    for (const fitness of fitnessResults) {
      events.push({
        id: `fitness-${fitness.id}`,
        type: 'fitness_test_recorded',
        timestamp: fitness.recordedAt.toISOString(),
        title: `Fitness test: ${fitness.testName}`,
        description: `${fitness.value} ${fitness.unit}`,
        metadata: {
          fitnessResultId: fitness.id,
          testName: fitness.testName,
          value: fitness.value.toString(),
          unit: fitness.unit,
        },
        actorName: fitness.recordedByUser
          ? `${fitness.recordedByUser.firstName} ${fitness.recordedByUser.lastName}`
          : null,
      });
    }

    for (const screening of screenings) {
      events.push({
        id: `screening-${screening.id}`,
        type: 'screening_completed',
        timestamp: screening.completedAt.toISOString(),
        title: 'Health screening completed',
        description: screening.flaggedForMedicalClearance
          ? 'Flagged for medical clearance'
          : 'Cleared',
        metadata: {
          screeningId: screening.id,
          flaggedForMedicalClearance: screening.flaggedForMedicalClearance,
          responseCount: screening.responses
            ? Object.keys(screening.responses as object).length
            : 0,
        },
        actorName: screening.recordedByUser
          ? `${screening.recordedByUser.firstName} ${screening.recordedByUser.lastName}`
          : null,
      });
    }

    for (const goal of goals) {
      events.push({
        id: `goal-created-${goal.id}`,
        type: 'goal_created',
        timestamp: goal.createdAt.toISOString(),
        title: `Goal created: ${goal.title}`,
        description: goal.description ?? null,
        metadata: {
          goalId: goal.id,
          category: goal.category,
          status: goal.status,
          targetValue: goal.targetValue?.toString() ?? null,
          targetUnit: goal.targetUnit,
        },
        actorName: goal.createdByUser
          ? `${goal.createdByUser.firstName} ${goal.createdByUser.lastName}`
          : null,
      });

      if (goal.status === 'ACHIEVED' && goal.achievedAt) {
        events.push({
          id: `goal-achieved-${goal.id}`,
          type: 'goal_achieved',
          timestamp: goal.achievedAt.toISOString(),
          title: `Goal achieved: ${goal.title}`,
          description: null,
          metadata: {
            goalId: goal.id,
            achievedAt: goal.achievedAt.toISOString(),
          },
          actorName: null,
        });
      } else if (goal.status === 'PAUSED') {
        events.push({
          id: `goal-paused-${goal.id}`,
          type: 'goal_paused',
          timestamp: goal.updatedAt.toISOString(),
          title: `Goal paused: ${goal.title}`,
          description: null,
          metadata: { goalId: goal.id },
          actorName: null,
        });
      } else if (goal.status === 'ABANDONED') {
        events.push({
          id: `goal-abandoned-${goal.id}`,
          type: 'goal_abandoned',
          timestamp: goal.updatedAt.toISOString(),
          title: `Goal abandoned: ${goal.title}`,
          description: null,
          metadata: { goalId: goal.id },
          actorName: null,
        });
      }
    }

    for (const doc of documents) {
      const latestFile = doc.versions[0]?.file;
      events.push({
        id: `document-${doc.id}`,
        type: 'document_uploaded',
        timestamp: doc.createdAt.toISOString(),
        title: `Document uploaded: ${latestFile?.originalName ?? 'unknown'}`,
        description: doc.description ?? null,
        metadata: {
          documentId: doc.id,
          category: doc.category,
          originalName: latestFile?.originalName ?? null,
        },
        actorName: null,
      });
    }

    for (const note of notes) {
      events.push({
        id: `note-${note.id}`,
        type: 'note_added',
        timestamp: note.createdAt.toISOString(),
        title: note.pinned ? 'Note pinned' : 'Note added',
        description:
          note.body.length > 100
            ? `${note.body.substring(0, 100)}...`
            : note.body,
        metadata: {
          noteId: note.id,
          pinned: note.pinned,
        },
        actorName: note.authorUser
          ? `${note.authorUser.firstName} ${note.authorUser.lastName}`
          : null,
      });
    }

    for (const consent of consents) {
      events.push({
        id: `consent-${consent.id}`,
        type: 'consent_recorded',
        timestamp: consent.createdAt.toISOString(),
        title: `Consent ${consent.granted ? 'granted' : 'revoked'}: ${consent.type}`,
        description: consent.note ?? null,
        metadata: {
          consentId: consent.id,
          type: consent.type,
          granted: consent.granted,
        },
        actorName: null,
      });
    }

    for (const log of messageLogs) {
      events.push({
        id: `message-${log.id}`,
        type: 'message_sent',
        timestamp: log.createdAt.toISOString(),
        title: `Message sent via ${log.channel}: ${log.category}`,
        description: log.recipient,
        metadata: {
          messageLogId: log.id,
          channel: log.channel,
          category: log.category,
          status: log.status,
          recipient: log.recipient,
        },
        actorName: null,
      });
    }

    events.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    const totalCount = events.length;
    const paginatedEvents = events.slice(skip, skip + pageSize);

    return {
      events: paginatedEvents,
      totalCount,
      page: safePage,
      pageSize: safePageSize,
    };
  }
}
