import { UnauthorizedException } from '@nestjs/common';
import type { OrganizationStatus } from '@prisma/client';

/**
 * A gym that platform staff have suspended or cancelled keeps its data but
 * not its access: no new sessions, and the ones already open stop working
 * on their next request. Platform staff, who belong to no organization,
 * are never affected.
 */
const CLOSED: readonly OrganizationStatus[] = ['SUSPENDED', 'CANCELLED'];

export const CLOSED_ORGANIZATION_MESSAGE =
  "This gym's account is suspended. Contact support to restore access.";

export function assertOrganizationOpen(
  organization: { status: OrganizationStatus; deletedAt: Date | null } | null,
): void {
  if (!organization) return;
  if (organization.deletedAt || CLOSED.includes(organization.status)) {
    throw new UnauthorizedException(CLOSED_ORGANIZATION_MESSAGE);
  }
}
