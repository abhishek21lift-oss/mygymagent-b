import { BadRequestException, Injectable } from '@nestjs/common';
import type { MfaPolicy } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MFA_PRIVILEGED_ROLE_KEYS } from '../../rbac/roles.catalog';

/** How long privileged staff get to enrol before enforcement bites, when
 * an admin switches the policy on without naming a date. Long enough to
 * cover someone on leave; short enough that the exposure is not open
 * ended. */
export const DEFAULT_MFA_GRACE_DAYS = 14;

/**
 * Where a user stands against their organization's second-factor policy.
 *
 * `ENFORCED` deliberately does not mean "refuse the login". Enrolling
 * requires an authenticated session, so refusing outright would lock every
 * privileged user out of the very screen that fixes it -- the exact
 * failure mode this rollout exists to avoid. It means "issue a session
 * that can do nothing but enrol" (see MfaEnrolmentGuard).
 */
export type MfaEnrolmentState = 'NOT_REQUIRED' | 'GRACE' | 'ENFORCED';

export interface MfaEnrolmentRequirement {
  state: MfaEnrolmentState;
  /** The date enforcement begins. Only ever set in `GRACE`. */
  deadline: Date | null;
}

const NOT_REQUIRED: MfaEnrolmentRequirement = {
  state: 'NOT_REQUIRED',
  deadline: null,
};

/** The policy columns this service needs, so callers that have already
 * loaded the organization (JwtStrategy joins it) can pass them straight in
 * instead of paying for a second round trip. */
export interface OrganizationMfaPolicy {
  mfaPolicy: MfaPolicy;
  mfaGraceUntil: Date | null;
}

@Injectable()
export class MfaPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * True when this organization's policy could restrict anyone at all.
   * Callers on hot paths check this first: an organization that has not
   * opted in costs zero extra queries.
   */
  static isEngaged(org: OrganizationMfaPolicy | null | undefined): boolean {
    return org?.mfaPolicy === 'REQUIRED_FOR_PRIVILEGED';
  }

  /**
   * Evaluates `userId` against an already-loaded policy.
   *
   * Order matters: the cheap disqualifiers come first so the role lookup
   * only runs for organizations that have actually switched enforcement on.
   */
  async evaluate(
    userId: string,
    org: OrganizationMfaPolicy | null | undefined,
    now: Date = new Date(),
  ): Promise<MfaEnrolmentRequirement> {
    if (!MfaPolicyService.isEngaged(org)) return NOT_REQUIRED;

    const record = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        mfa: { select: { enabledAt: true } },
        userRoles: {
          where: { role: { key: { in: [...MFA_PRIVILEGED_ROLE_KEYS] } } },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!record) return NOT_REQUIRED;

    // Already protected, or not a role the policy covers.
    if (record.mfa?.enabledAt) return NOT_REQUIRED;
    if (record.userRoles.length === 0) return NOT_REQUIRED;

    const graceUntil = org?.mfaGraceUntil ?? null;
    if (graceUntil && graceUntil > now) {
      return { state: 'GRACE', deadline: graceUntil };
    }
    return { state: 'ENFORCED', deadline: null };
  }

  /** Same evaluation, for callers that do not already hold the
   * organization row (login, /auth/me). */
  async evaluateForUser(
    userId: string,
    now: Date = new Date(),
  ): Promise<MfaEnrolmentRequirement> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        organization: {
          select: { mfaPolicy: true, mfaGraceUntil: true },
        },
      },
    });
    return this.evaluate(userId, user?.organization ?? null, now);
  }

  // ---------------------------------------------------------------------
  // Administration: reading and changing the policy, and the enrolment
  // report that has to inform the decision.
  // ---------------------------------------------------------------------

  /**
   * Who the policy covers and whether they are protected yet.
   *
   * This is the report the rollout depends on: turning enforcement on
   * without first seeing who is unenrolled is how an organization
   * discovers its accountant is on holiday the hard way.
   */
  async report(organizationId: string, now: Date = new Date()) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { mfaPolicy: true, mfaGraceUntil: true },
    });
    if (!organization) {
      throw new BadRequestException('Organization not found');
    }

    const users = await this.prisma.user.findMany({
      where: {
        organizationId,
        deletedAt: null,
        userRoles: {
          some: { role: { key: { in: [...MFA_PRIVILEGED_ROLE_KEYS] } } },
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        status: true,
        mfa: { select: { enabledAt: true } },
        userRoles: {
          where: { role: { key: { in: [...MFA_PRIVILEGED_ROLE_KEYS] } } },
          select: { role: { select: { key: true } } },
        },
      },
      orderBy: [{ firstName: 'asc' }, { email: 'asc' }],
    });

    const rows = users.map((user) => ({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      // De-duplicated: the same role key can appear once per branch.
      roles: [...new Set(user.userRoles.map((ur) => ur.role.key))].sort(),
      mfaEnabled: Boolean(user.mfa?.enabledAt),
      mfaEnabledAt: user.mfa?.enabledAt ?? null,
    }));

    const enrolled = rows.filter((row) => row.mfaEnabled).length;
    return {
      policy: organization.mfaPolicy,
      graceUntil: organization.mfaGraceUntil,
      enforcementActive: this.isEnforcementActive(organization, now),
      summary: {
        total: rows.length,
        enrolled,
        pending: rows.length - enrolled,
      },
      users: rows,
    };
  }

  /** True when unenrolled privileged users are being restricted right now
   * (as opposed to merely warned). */
  isEnforcementActive(
    org: OrganizationMfaPolicy,
    now: Date = new Date(),
  ): boolean {
    if (!MfaPolicyService.isEngaged(org)) return false;
    return !(org.mfaGraceUntil && org.mfaGraceUntil > now);
  }

  async getPolicy(organizationId: string, now: Date = new Date()) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { mfaPolicy: true, mfaGraceUntil: true },
    });
    if (!organization) {
      throw new BadRequestException('Organization not found');
    }
    return {
      policy: organization.mfaPolicy,
      graceUntil: organization.mfaGraceUntil,
      enforcementActive: this.isEnforcementActive(organization, now),
      privilegedRoles: [...MFA_PRIVILEGED_ROLE_KEYS],
    };
  }

  /**
   * Changes the policy.
   *
   * Switching enforcement on without naming a date grants the default
   * grace window rather than restricting every privileged user the same
   * second. Enforcing immediately stays possible -- an incident is a real
   * reason to -- but it has to be asked for, by sending `graceUntil: null`
   * explicitly.
   */
  async updatePolicy(
    organizationId: string,
    input: { policy: MfaPolicy; graceUntil?: Date | null },
    now: Date = new Date(),
  ) {
    const current = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { mfaPolicy: true, mfaGraceUntil: true },
    });
    if (!current) {
      throw new BadRequestException('Organization not found');
    }

    if (input.policy === 'OPTIONAL') {
      // Clearing the grace date too: leaving a stale one behind would make
      // a later re-enable silently enforce from a date already past.
      await this.prisma.organization.update({
        where: { id: organizationId },
        data: { mfaPolicy: 'OPTIONAL', mfaGraceUntil: null },
      });
      return this.getPolicy(organizationId, now);
    }

    if (input.graceUntil !== undefined && input.graceUntil !== null) {
      if (input.graceUntil <= now) {
        throw new BadRequestException(
          'graceUntil must be in the future. Send null to enforce immediately.',
        );
      }
    }

    const graceUntil =
      input.graceUntil !== undefined
        ? input.graceUntil
        : // Turning it on for the first time earns the default window;
          // re-saving an already-enforcing policy must not silently hand
          // out a fresh one.
          MfaPolicyService.isEngaged(current)
          ? current.mfaGraceUntil
          : new Date(now.getTime() + DEFAULT_MFA_GRACE_DAYS * 86_400_000);

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { mfaPolicy: input.policy, mfaGraceUntil: graceUntil },
    });
    return this.getPolicy(organizationId, now);
  }
}
