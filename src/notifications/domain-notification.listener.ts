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
import { NotificationsService } from './notifications.service';

@Injectable()
export class DomainNotificationListener {
  constructor(private readonly notifications: NotificationsService) {}

  @OnEvent(DomainEvent.MemberCreated)
  handleMemberCreated(event: MemberCreatedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'MEMBER_CREATED',
      title: 'New member added',
      body: event.firstName
        ? `${event.firstName} was added as a new member.`
        : 'A new member was added.',
      actionUrl: `/members/${event.memberId}`,
      metadata: { memberId: event.memberId, branchId: event.branchId },
    });
  }

  @OnEvent(DomainEvent.MembershipStarted)
  handleMembershipStarted(event: MembershipStartedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'MEMBERSHIP_STARTED',
      title: 'Membership started',
      body: 'A member membership has been started.',
      actionUrl: `/members/${event.memberId}`,
      metadata: { membershipId: event.membershipId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.MembershipCancelled)
  handleMembershipCancelled(event: MembershipCancelledEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'MEMBERSHIP_CANCELLED',
      title: 'Membership cancelled',
      body: 'A member membership has been cancelled.',
      actionUrl: `/members/${event.memberId}`,
      metadata: { membershipId: event.membershipId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.AttendanceRecorded)
  handleAttendanceRecorded(event: AttendanceRecordedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'ATTENDANCE_RECORDED',
      title: 'Attendance recorded',
      body: 'New attendance has been recorded.',
      actionUrl: event.memberId ? `/members/${event.memberId}` : undefined,
      metadata: { attendanceId: event.attendanceId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.PaymentRecorded)
  handlePaymentRecorded(event: PaymentRecordedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'PAYMENT_RECORDED',
      title: 'Payment recorded',
      body: `Payment of ${event.amount} ${event.currency} was recorded.`,
      actionUrl: `/members/${event.memberId}`,
      metadata: { paymentId: event.paymentId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.PaymentRefunded)
  handlePaymentRefunded(event: PaymentRefundedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'PAYMENT_REFUNDED',
      title: 'Payment refunded',
      body: `A refund of ${event.amount} was recorded.`,
      actionUrl: `/members/${event.memberId}`,
      metadata: {
        refundId: event.refundId,
        paymentId: event.paymentId,
        memberId: event.memberId,
      },
    });
  }

  @OnEvent(DomainEvent.LeadConverted)
  handleLeadConverted(event: LeadConvertedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'LEAD_CONVERTED',
      title: 'Lead converted',
      body: 'A CRM lead has been converted into a member.',
      actionUrl: `/members/${event.memberId}`,
      metadata: { leadId: event.leadId, memberId: event.memberId },
    });
  }

  @OnEvent(DomainEvent.LeadCreated)
  handleLeadCreated(event: LeadCreatedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'LEAD_CREATED',
      title: 'New lead',
      body: 'A new CRM lead has been created.',
      actionUrl: `/crm/leads/${event.leadId}`,
      metadata: {
        leadId: event.leadId,
        branchId: event.branchId,
        channel: event.channel,
      },
    });
  }

  @OnEvent(DomainEvent.WorkoutAssigned)
  handleWorkoutAssigned(event: WorkoutAssignedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'WORKOUT_ASSIGNED',
      title: 'Workout assigned',
      body: 'A workout plan has been assigned to a member.',
      actionUrl: `/members/${event.memberId}`,
      metadata: {
        workoutAssignmentId: event.workoutAssignmentId,
        memberId: event.memberId,
      },
    });
  }

  @OnEvent(DomainEvent.WorkoutSessionStarted)
  handleWorkoutSessionStarted(event: WorkoutSessionStartedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'WORKOUT_SESSION_STARTED',
      title: 'Workout started',
      body: 'A member workout session has started.',
      actionUrl: `/members/${event.memberId}`,
      metadata: {
        workoutSessionId: event.workoutSessionId,
        memberId: event.memberId,
      },
    });
  }

  @OnEvent(DomainEvent.WorkoutSessionCompleted)
  handleWorkoutSessionCompleted(event: WorkoutSessionCompletedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'WORKOUT_SESSION_COMPLETED',
      title: 'Workout completed',
      body: 'A member workout session has been completed.',
      actionUrl: `/members/${event.memberId}`,
      metadata: {
        workoutSessionId: event.workoutSessionId,
        memberId: event.memberId,
      },
    });
  }

  @OnEvent(DomainEvent.DietAssigned)
  handleDietAssigned(event: DietAssignedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'DIET_ASSIGNED',
      title: 'Diet assigned',
      body: 'A diet plan has been assigned to a member.',
      actionUrl: `/members/${event.memberId}`,
      metadata: {
        dietAssignmentId: event.dietAssignmentId,
        memberId: event.memberId,
      },
    });
  }

  @OnEvent(DomainEvent.InventoryLow)
  handleInventoryLow(event: InventoryLowEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'INVENTORY_LOW',
      title: 'Low stock alert',
      body: `${event.name} is low on stock (${event.quantityOnHand} remaining).`,
      actionUrl: `/inventory/products/${event.productId}`,
      metadata: {
        productId: event.productId,
        sku: event.sku,
        quantityOnHand: event.quantityOnHand,
        reorderLevel: event.reorderLevel,
      },
    });
  }

  @OnEvent(DomainEvent.PtSessionBooked)
  handlePtSessionBooked(event: PtSessionBookedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'PT_SESSION_BOOKED',
      title: 'PT session booked',
      body: 'A personal training session has been booked.',
      actionUrl: `/pt/sessions/${event.ptSessionId}`,
      metadata: {
        ptSessionId: event.ptSessionId,
        memberId: event.memberId,
        trainerId: event.trainerId,
      },
    });
  }

  @OnEvent(DomainEvent.PtSessionCompleted)
  handlePtSessionCompleted(event: PtSessionCompletedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'PT_SESSION_COMPLETED',
      title: 'PT session completed',
      body: 'A personal training session has been completed.',
      actionUrl: `/pt/sessions/${event.ptSessionId}`,
      metadata: {
        ptSessionId: event.ptSessionId,
        memberId: event.memberId,
        trainerId: event.trainerId,
      },
    });
  }

  @OnEvent(DomainEvent.PtSessionCancelled)
  handlePtSessionCancelled(event: PtSessionCancelledEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'PT_SESSION_CANCELLED',
      title: 'PT session cancelled',
      body: 'A personal training session has been cancelled.',
      actionUrl: `/pt/sessions/${event.ptSessionId}`,
      metadata: {
        ptSessionId: event.ptSessionId,
        memberId: event.memberId,
        trainerId: event.trainerId,
      },
    });
  }

  @OnEvent(DomainEvent.WhatsappReceived)
  handleWhatsappReceived(event: WhatsappReceivedEvent) {
    return this.notifications.notifyOrganization(event.organizationId, {
      type: 'WHATSAPP_RECEIVED',
      title: 'New WhatsApp message',
      body: event.matchedMemberId
        ? 'A WhatsApp message was received from a matched member.'
        : 'A WhatsApp message was received from an unmatched number.',
      actionUrl: '/whatsapp/inbox',
      metadata: {
        inboundMessageId: event.inboundMessageId,
        matchedMemberId: event.matchedMemberId,
      },
    });
  }
}
