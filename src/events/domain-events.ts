/**
 * Domain event catalog. Emitted via EventEmitter2 so modules can subscribe
 * without the emitting module knowing their implementation details.
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
  PtSessionBooked: 'pt.session.booked',
  PtSessionCompleted: 'pt.session.completed',
  PtSessionCancelled: 'pt.session.cancelled',
} as const;

export interface MemberCreatedEvent {
  organizationId: string;
  branchId: string;
  memberId: string;
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

export interface PtSessionBookedEvent {
  organizationId: string;
  ptSessionId: string;
  memberId: string;
  trainerId?: string;
  branchId: string;
  startTime: Date;
  endTime: Date;
  bookedByUserId: string;
}

export interface PtSessionCompletedEvent {
  organizationId: string;
  ptSessionId: string;
  memberId: string;
  trainerId?: string;
  branchId: string;
  completedByUserId: string;
  actualEndTime: Date;
}

export interface PtSessionCancelledEvent {
  organizationId: string;
  ptSessionId: string;
  memberId: string;
  trainerId?: string;
  branchId: string;
  cancelledByUserId: string;
  cancellationReason?: string;
}
