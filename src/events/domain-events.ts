/**
 * Domain event catalog. Emitted via EventEmitter2 (registered globally by
 * EventEmitterModule.forRoot() in AppModule) so future modules -- the
 * Notifications engine, AI Retention Agent, analytics aggregation jobs --
 * can subscribe without the emitting module knowing they exist. See
 * docs/ARCHITECTURE.md#event-architecture.
 *
 * Only events actually emitted today are listed with a payload type; the
 * rest of the catalog described in the product blueprint (LeadConverted,
 * InventoryLow, ...) will be added by the module that produces them.
 */
export const DomainEvent = {
  MemberCreated: 'member.created',
  MembershipStarted: 'membership.started',
  MembershipCancelled: 'membership.cancelled',
  AttendanceRecorded: 'attendance.recorded',
  PaymentRecorded: 'payment.recorded',
  PaymentRefunded: 'payment.refunded',
  WorkoutAssigned: 'workout.assigned',
} as const;

export interface MemberCreatedEvent {
  organizationId: string;
  branchId: string;
  memberId: string;
}

export interface MembershipStartedEvent {
  organizationId: string;
  branchId: string;
  membershipId: string;
  memberId: string;
  membershipPlanId: string;
}

export interface MembershipCancelledEvent {
  organizationId: string;
  membershipId: string;
  memberId: string;
}

export interface AttendanceRecordedEvent {
  organizationId: string;
  branchId: string;
  attendanceId: string;
  memberId?: string;
  staffUserId?: string;
}

export interface PaymentRecordedEvent {
  organizationId: string;
  branchId: string;
  paymentId: string;
  memberId: string;
  membershipId?: string;
  amount: string;
  currency: string;
}

export interface PaymentRefundedEvent {
  organizationId: string;
  paymentId: string;
  refundId: string;
  memberId: string;
  amount: string;
}

export interface WorkoutAssignedEvent {
  organizationId: string;
  workoutAssignmentId: string;
  workoutPlanId: string;
  memberId: string;
  assignedByUserId?: string;
}
