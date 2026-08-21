/**
 * Domain event catalog. Emitted via EventEmitter2 (registered globally by
 * EventEmitterModule.forRoot() in AppModule) so future modules -- the
 * Notifications engine, AI Retention Agent, analytics aggregation jobs --
 * can subscribe without the emitting module knowing they exist. See
 * docs/ARCHITECTURE.md#event-architecture.
 *
 * Only events actually emitted today are listed with a payload type; the
 * rest of the catalog described in the product blueprint (InventoryLow,
 * ...) will be added by the module that produces them.
 */
export const DomainEvent = {
  MemberCreated: 'member.created',
  MembershipStarted: 'membership.started',
  MembershipCancelled: 'membership.cancelled',
  AttendanceRecorded: 'attendance.recorded',
  PaymentRecorded: 'payment.recorded',
  PaymentRefunded: 'payment.refunded',
  WorkoutAssigned: 'workout.assigned',
  LeadConverted: 'lead.converted',
  DietAssigned: 'diet.assigned',
  InventoryLow: 'inventory.low',
} as const;

export interface MemberCreatedEvent {
  organizationId: string;
  branchId: string;
  memberId: string;
  /// Included so a listener (e.g. the welcome-email job) doesn't need its
  /// own DB round-trip just to get what MembersService.create() already
  /// had in hand. Undefined when the member has no email/name on file --
  /// listeners that need one must check, not assume.
  email?: string;
  firstName?: string;
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

export interface LeadConvertedEvent {
  organizationId: string;
  leadId: string;
  memberId: string;
}

export interface DietAssignedEvent {
  organizationId: string;
  dietAssignmentId: string;
  dietPlanId: string;
  memberId: string;
  assignedByUserId?: string;
}

export interface InventoryLowEvent {
  organizationId: string;
  productId: string;
  sku: string;
  name: string;
  quantityOnHand: number;
  reorderLevel: number;
}
