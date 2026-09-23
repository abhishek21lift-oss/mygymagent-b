import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_MFA_ENROLMENT_KEY = 'allowPendingMfaEnrolment';

/**
 * Marks a route as reachable from an enrolment-scoped session -- one held
 * by a privileged user whose organization requires a second factor that
 * they have not set up yet.
 *
 * Keep this list to what enrolling genuinely needs. Every route wearing it
 * is reachable by someone whose account the policy has already judged
 * under-protected, so anything that reads member data, moves money or
 * changes settings must not carry it.
 */
export const AllowPendingMfaEnrolment = () =>
  SetMetadata(ALLOW_PENDING_MFA_ENROLMENT_KEY, true);
