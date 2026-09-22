/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  DomainEvent,
  type AttendanceRecordedEvent,
  type DietAssignedEvent,
  type LeadConvertedEvent,
  type MemberCreatedEvent,
  type MembershipCancelledEvent,
  type InventoryLowEvent,
  type LeadCreatedEvent,
  type MembershipStartedEvent,
  type PaymentRecordedEvent,
  type PaymentRefundedEvent,
  type PtSessionBookedEvent,
  type PtSessionCancelledEvent,
  type PtSessionCompletedEvent,
  type WhatsappReceivedEvent,
  type WorkoutAssignedEvent,
  type WorkoutSessionCompletedEvent,
  type WorkoutSessionStartedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

@Injectable()
export class DomainNotificationListener {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  private async notify(organizationId: string, input: Omit<Parameters<NotificationsService['notifyOrganization']>[1], 'metadata'> & { metadata?: Record<string, unknown> }) {
    return this.notifications.notifyOrganization(organizationId, input);
  }

  @OnEvent(DomainEvent.MemberCreated)
  handleMemberCreated(event: MemberCreatedEvent) {
    return this.notify(event.organizationId, {
      type: 'MEMBER_CREATED', category: 'MEMBERS', priority: 'NORMAL',
      title: 'New member added',
      body: event.firstName ? `${event.firstName} was added as a new member.` : 'A new member was added.',
      actionUrl: `/members/${event.memberId}`, branchId: event.branchId,
      entityType: 'member', entityId: event.memberId,
      metadata: { memberId: event.memberId, branchId: event.branchId },
    });
  }

  @OnEvent(DomainEvent.MembershipStarted)
  handleMembershipStarted(event: MembershipStartedEvent) {
    return this.notify(event.organizationId, {
      type: 'MEMBERSHIP_STARTED', category: 'MEMBERSHIPS', priority: 'NORMAL',
      title: 'Membership started', body: 'A member membership has been started.',
      actionUrl: `/members/${event.memberId}`, branchId: event.branchId,
      entityType: 'membership', entityId: event.membershipId,
      metadata: { membershipId: event.membershipId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.MembershipCancelled)
  handleMembershipCancelled(event: MembershipCancelledEvent) {
    return this.notify(event.organizationId, {
      type: 'MEMBERSHIP_CANCELLED', category: 'MEMBERSHIPS', priority: 'HIGH',
      title: 'Membership cancelled', body: 'A member membership has been cancelled.',
      actionUrl: `/members/${event.memberId}`, branchId: event.branchId,
      entityType: 'membership', entityId: event.membershipId,
      metadata: { membershipId: event.membershipId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.AttendanceRecorded)
  handleAttendanceRecorded(event: AttendanceRecordedEvent) {
    return this.notify(event.organizationId, {
      type: 'ATTENDANCE_RECORDED', category: 'ATTENDANCE', priority: 'LOW',
      title: 'Attendance recorded', body: 'New attendance has been recorded.',
      actionUrl: event.memberId ? `/members/${event.memberId}` : undefined,
      branchId: event.branchId, actorUserId: event.staffUserId,
      entityType: 'attendance', entityId: event.attendanceId,
      metadata: { attendanceId: event.attendanceId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.PaymentRecorded)
  handlePaymentRecorded(event: PaymentRecordedEvent) {
    return this.notify(event.organizationId, {
      type: 'PAYMENT_RECORDED', category: 'PAYMENTS', priority: 'NORMAL',
      title: 'Payment recorded', body: `Payment of ${event.amount} ${event.currency} was recorded.`,
      actionUrl: `/members/${event.memberId}`, branchId: event.branchId,
      entityType: 'payment', entityId: event.paymentId,
      metadata: { paymentId: event.paymentId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.PaymentRefunded)
  handlePaymentRefunded(event: PaymentRefundedEvent) {
    return this.notify(event.organizationId, {
      type: 'PAYMENT_REFUNDED', category: 'PAYMENTS', priority: 'HIGH',
      title: 'Payment refunded', body: `A refund of ${event.amount} was recorded.`,
      actionUrl: `/members/${event.memberId}`, branchId: event.branchId,
      entityType: 'refund', entityId: event.refundId,
      metadata: { refundId: event.refundId, paymentId: event.paymentId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.LeadConverted)
  handleLeadConverted(event: LeadConvertedEvent) {
    return this.notify(event.organizationId, {
      type: 'LEAD_CONVERTED', category: 'CRM', priority: 'NORMAL',
      title: 'Lead converted', body: 'A CRM lead has been converted into a member.',
      actionUrl: `/members/${event.memberId}`, branchId: event.branchId,
      entityType: 'lead', entityId: event.leadId,
      metadata: { leadId: event.leadId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.LeadCreated)
  handleLeadCreated(event: LeadCreatedEvent) {
    return this.notify(event.organizationId, {
      type: 'LEAD_CREATED', category: 'CRM', priority: 'NORMAL',
      title: 'New lead', body: 'A new CRM lead has been created.',
      actionUrl: `/crm/leads/${event.leadId}`, branchId: event.branchId,
      entityType: 'lead', entityId: event.leadId,
      metadata: { leadId: event.leadId, branchId: event.branchId, channel: event.channel },
    });
  }

  @OnEvent(DomainEvent.WorkoutAssigned)
  handleWorkoutAssigned(event: WorkoutAssignedEvent) {
    return this.notify(event.organizationId, {
      type: 'WORKOUT_ASSIGNED', category: 'WORKOUT', priority: 'NORMAL',
      title: 'Workout assigned', body: 'A workout plan has been assigned to a member.',
      actionUrl: `/members/${event.memberId}`, branchId: event.branchId, actorUserId: event.assignedByUserId,
      entityType: 'workout_assignment', entityId: event.workoutAssignmentId,
      metadata: { workoutAssignmentId: event.workoutAssignmentId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.WorkoutSessionStarted)
  handleWorkoutSessionStarted(event: WorkoutSessionStartedEvent) {
    return this.notify(event.organizationId, {
      type: 'WORKOUT_SESSION_STARTED', category: 'WORKOUT', priority: 'LOW',
      title: 'Workout started', body: 'A member workout session has started.',
      actionUrl: `/members/${event.memberId}`, branchId: event.branchId, actorUserId: event.startedByUserId,
      entityType: 'workout_session', entityId: event.workoutSessionId,
      metadata: { workoutSessionId: event.workoutSessionId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.WorkoutSessionCompleted)
  handleWorkoutSessionCompleted(event: WorkoutSessionCompletedEvent) {
    return this.notify(event.organizationId, {
      type: 'WORKOUT_SESSION_COMPLETED', category: 'WORKOUT', priority: 'LOW',
      title: 'Workout completed', body: 'A member workout session has been completed.',
      actionUrl: `/members/${event.memberId}`, branchId: event.branchId, actorUserId: event.completedByUserId,
      entityType: 'workout_session', entityId: event.workoutSessionId,
      metadata: { workoutSessionId: event.workoutSessionId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.DietAssigned)
  handleDietAssigned(event: DietAssignedEvent) {
    return this.notify(event.organizationId, {
      type: 'DIET_ASSIGNED', category: 'DIET', priority: 'NORMAL',
      title: 'Diet assigned', body: 'A diet plan has been assigned to a member.',
      actionUrl: `/members/${event.memberId}`, branchId: event.branchId, actorUserId: event.assignedByUserId,
      entityType: 'diet_assignment', entityId: event.dietAssignmentId,
      metadata: { dietAssignmentId: event.dietAssignmentId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.InventoryLow)
  handleInventoryLow(event: InventoryLowEvent) {
    return this.notify(event.organizationId, {
      type: 'INVENTORY_LOW', category: 'INVENTORY', priority: 'HIGH',
      title: 'Low stock alert', body: `${event.name} is low on stock (${event.quantityOnHand} remaining).`,
      actionUrl: `/inventory/products/${event.productId}`, branchId: event.branchId,
      entityType: 'product', entityId: event.productId,
      metadata: { productId: event.productId, sku: event.sku, quantityOnHand: event.quantityOnHand, reorderLevel: event.reorderLevel },
    });
  }

  @OnEvent(DomainEvent.PtSessionBooked)
  async handlePtSessionBooked(event: PtSessionBookedEvent) {
    const trainerUser = event.trainerId
      ? await this.prisma.staffProfile.findUnique({ where: { id: event.trainerId }, select: { userId: true } })
      : null;
    return this.notify(event.organizationId, {
      type: 'PT_SESSION_BOOKED', category: 'PT', priority: 'HIGH',
      title: 'PT session booked', body: 'A personal training session has been booked.',
      actionUrl: `/pt/sessions/${event.ptSessionId}`, branchId: event.branchId,
      entityType: 'pt_session', entityId: event.ptSessionId,
      recipientUserIds: trainerUser ? [trainerUser.userId] : undefined,
      metadata: { ptSessionId: event.ptSessionId, memberId: event.memberId, trainerId: event.trainerId, startTime: event.startTime },
    });
  }

  @OnEvent(DomainEvent.PtSessionCompleted)
  async handlePtSessionCompleted(event: PtSessionCompletedEvent) {
    const trainerUser = event.trainerId
      ? await this.prisma.staffProfile.findUnique({ where: { id: event.trainerId }, select: { userId: true } })
      : null;
    return this.notify(event.organizationId, {
      type: 'PT_SESSION_COMPLETED', category: 'PT', priority: 'NORMAL',
      title: 'PT session completed', body: 'A personal training session has been completed.',
      actionUrl: `/pt/sessions/${event.ptSessionId}`, branchId: event.branchId,
      entityType: 'pt_session', entityId: event.ptSessionId,
      recipientUserIds: trainerUser ? [trainerUser.userId] : undefined,
      metadata: { ptSessionId: event.ptSessionId, memberId: event.memberId, trainerId: event.trainerId },
    });
  }

  @OnEvent(DomainEvent.PtSessionCancelled)
  async handlePtSessionCancelled(event: PtSessionCancelledEvent) {
    const trainerUser = event.trainerId
      ? await this.prisma.staffProfile.findUnique({ where: { id: event.trainerId }, select: { userId: true } })
      : null;
    return this.notify(event.organizationId, {
      type: 'PT_SESSION_CANCELLED', category: 'PT', priority: 'HIGH',
      title: 'PT session cancelled', body: 'A personal training session has been cancelled.',
      actionUrl: `/pt/sessions/${event.ptSessionId}`, branchId: event.branchId,
      entityType: 'pt_session', entityId: event.ptSessionId,
      recipientUserIds: trainerUser ? [trainerUser.userId] : undefined,
      metadata: { ptSessionId: event.ptSessionId, memberId: event.memberId, trainerId: event.trainerId, reason: event.cancellationReason },
    });
  }

  @OnEvent(DomainEvent.WhatsappReceived)
  handleWhatsappReceived(event: WhatsappReceivedEvent) {
    return this.notify(event.organizationId, {
      type: 'WHATSAPP_RECEIVED', category: 'WHATSAPP', priority: 'HIGH',
      title: 'New WhatsApp message',
      body: event.matchedMemberId ? 'A WhatsApp message was received from a matched member.' : 'A WhatsApp message was received from an unmatched number.',
      actionUrl: '/whatsapp/inbox',
      entityType: 'whatsapp_message', entityId: event.inboundMessageId,
      metadata: { inboundMessageId: event.inboundMessageId, matchedMemberId: event.matchedMemberId },
    });
  }
}
