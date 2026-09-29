import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  DomainEvent,
  type AttendanceRecordedEvent,
  type DietAssignedEvent,
  type MembershipCancelledEvent,
  type MembershipStartedEvent,
  type PaymentRecordedEvent,
  type PaymentRefundedEvent,
  type PtSessionBookedEvent,
  type PtSessionCancelledEvent,
  type WorkoutAssignedEvent,
} from '../../events/domain-events';
import { PrismaService } from '../../prisma/prisma.service';
import { MemberPushService } from './member-push.service';

/**
 * The member's side of the domain events that `DomainNotificationListener`
 * turns into staff notifications. Kept apart because the audience, the
 * wording ("Your PT session is booked", not "A personal training session
 * has been booked") and the links (portal routes, not staff screens) all
 * differ.
 *
 * Deliberately not pushed: workout sessions started/completed and PT
 * sessions completed -- the member was there; a push would only echo it.
 * A check-in *is* pushed: it is a receipt that the scan worked, and the
 * first sign that someone else is using your entry credential.
 */
@Injectable()
export class MemberPushListener {
  constructor(
    private readonly members: MemberPushService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent(DomainEvent.MembershipStarted)
  async membershipStarted(event: MembershipStartedEvent) {
    const plan = await this.prisma.membershipPlan
      .findFirst({
        where: {
          id: event.membershipPlanId,
          organizationId: event.organizationId,
        },
        select: { name: true },
      })
      .catch(() => null);
    await this.members.notifyMember(event.organizationId, event.memberId, {
      type: 'MEMBERSHIP_STARTED',
      category: 'MEMBERSHIPS',
      title: 'Your membership is active',
      body: plan?.name
        ? `${plan.name} has started. See you at the gym!`
        : 'Your new membership has started. See you at the gym!',
      actionUrl: '/portal',
      dedupeKey: `membership-started:${event.membershipId}`,
    });
  }

  @OnEvent(DomainEvent.MembershipCancelled)
  async membershipCancelled(event: MembershipCancelledEvent) {
    await this.members.notifyMember(event.organizationId, event.memberId, {
      type: 'MEMBERSHIP_CANCELLED',
      category: 'MEMBERSHIPS',
      title: 'Your membership was cancelled',
      body: 'If this is unexpected, please contact the front desk.',
      actionUrl: '/portal',
      dedupeKey: `membership-cancelled:${event.membershipId}`,
    });
  }

  @OnEvent(DomainEvent.AttendanceRecorded)
  async attendanceRecorded(event: AttendanceRecordedEvent) {
    if (!event.memberId) return;
    const branch = await this.prisma.branch
      .findFirst({
        where: { id: event.branchId, organizationId: event.organizationId },
        select: { name: true },
      })
      .catch(() => null);
    await this.members.notifyMember(event.organizationId, event.memberId, {
      type: 'ATTENDANCE_RECORDED',
      category: 'ATTENDANCE',
      title: 'Checked in',
      body: branch?.name
        ? `You're checked in at ${branch.name}. Have a great session!`
        : "You're checked in. Have a great session!",
      actionUrl: '/portal/visits',
      dedupeKey: `attendance:${event.attendanceId}`,
    });
  }

  @OnEvent(DomainEvent.PaymentRecorded)
  async paymentRecorded(event: PaymentRecordedEvent) {
    await this.members.notifyMember(event.organizationId, event.memberId, {
      type: 'PAYMENT_RECORDED',
      category: 'PAYMENTS',
      title: 'Payment received',
      body: `We received your payment of ${this.members.formatAmount(event.amount, event.currency)}. Thank you!`,
      actionUrl: '/portal/billing',
      dedupeKey: `payment:${event.paymentId}`,
    });
  }

  @OnEvent(DomainEvent.PaymentRefunded)
  async paymentRefunded(event: PaymentRefundedEvent) {
    const payment = await this.prisma.payment
      .findFirst({
        where: { id: event.paymentId, organizationId: event.organizationId },
        select: { currency: true },
      })
      .catch(() => null);
    await this.members.notifyMember(event.organizationId, event.memberId, {
      type: 'PAYMENT_REFUNDED',
      category: 'PAYMENTS',
      title: 'Refund issued',
      // No currency means no guess: a wrong symbol is worse than none.
      body: `A refund of ${payment?.currency ? this.members.formatAmount(event.amount, payment.currency) : event.amount} is on its way to you.`,
      actionUrl: '/portal/billing',
      dedupeKey: `refund:${event.refundId}`,
    });
  }

  @OnEvent(DomainEvent.WorkoutAssigned)
  async workoutAssigned(event: WorkoutAssignedEvent) {
    await this.members.notifyMember(event.organizationId, event.memberId, {
      type: 'WORKOUT_ASSIGNED',
      category: 'WORKOUT',
      title: 'New workout plan',
      body: 'Your trainer has assigned you a new workout plan.',
      actionUrl: '/portal/plan',
      dedupeKey: `workout:${event.workoutAssignmentId}`,
      actorUserId: event.assignedByUserId,
    });
  }

  @OnEvent(DomainEvent.DietAssigned)
  async dietAssigned(event: DietAssignedEvent) {
    await this.members.notifyMember(event.organizationId, event.memberId, {
      type: 'DIET_ASSIGNED',
      category: 'DIET',
      title: 'New diet plan',
      body: 'You have a new diet plan to follow.',
      actionUrl: '/portal/nutrition',
      dedupeKey: `diet:${event.dietAssignmentId}`,
      actorUserId: event.assignedByUserId,
    });
  }

  @OnEvent(DomainEvent.PtSessionBooked)
  async ptSessionBooked(event: PtSessionBookedEvent) {
    const when = await this.members.formatWhen(
      event.organizationId,
      new Date(event.startTime),
    );
    await this.members.notifyMember(event.organizationId, event.memberId, {
      type: 'PT_SESSION_BOOKED',
      category: 'PT',
      title: 'PT session booked',
      body: `Your personal training session is booked for ${when}.`,
      actionUrl: '/portal/plan',
      dedupeKey: `pt-booked:${event.ptSessionId}`,
      actorUserId: event.bookedByUserId,
    });
  }

  @OnEvent(DomainEvent.PtSessionCancelled)
  async ptSessionCancelled(event: PtSessionCancelledEvent) {
    await this.members.notifyMember(event.organizationId, event.memberId, {
      type: 'PT_SESSION_CANCELLED',
      category: 'PT',
      title: 'PT session cancelled',
      body: event.cancellationReason
        ? `Your personal training session was cancelled: ${event.cancellationReason}`
        : 'Your personal training session was cancelled.',
      actionUrl: '/portal/plan',
      dedupeKey: `pt-cancelled:${event.ptSessionId}`,
      actorUserId: event.cancelledByUserId,
    });
  }
}
