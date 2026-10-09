import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { phoneKey } from '../data/customer-enquiry-mapping';
import {
  OTP_DELIVERY,
  type OtpDelivery,
} from './otp-delivery/otp-delivery.interface';

export interface OtpRequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

/** Long enough to type from a notification, short enough that guessing
 * inside the window is hopeless at five attempts. Overridable per
 * deployment via OTP_EXPIRY_SECONDS (default 300, capped at 900 by the
 * env schema) so the window is configuration rather than a constant
 * someone has to recompile to change. */
const DEFAULT_CODE_TTL_SECONDS = 300;
/** Wrong guesses allowed against one issued code before it is spent. */
const MAX_ATTEMPTS = 5;
/** A second request inside this window reuses nothing and sends nothing,
 * so a hostile caller cannot bill the gym for SMS or flood a member's
 * handset by holding down a button. */
const RESEND_COOLDOWN_MS = 60_000;
/** Codes one number can be sent in a day. The cooldown alone still let a
 * script send one a minute -- 1,440 billed messages a day per number. */
const MAX_CODES_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Passwordless login for members, by a code sent to their phone.
 *
 * This exists because the members cannot use the login that already
 * works: of 954 imported into this deployment, 947 have a phone number
 * and no email address, and none has ever had a password. Email is not
 * a second option for them, it is no option.
 *
 * What it deliberately is not: an SMS second factor for staff, a
 * password reset over SMS, or a way to change the number on an account.
 * Each is a separate decision about who may enter, and none of them is
 * needed to let a member read their own membership.
 *
 * The code is hashed, expired and counted here. Producing and delivering
 * it is `OtpDelivery` — MSG91 in production, a fixed no-send code in
 * development and test. This class does not check which one it holds:
 * that decision belongs to the provider (see
 * `otp-delivery.interface.ts`), because a service that branched on "am I
 * the mock?" would be one edit away from taking the branch the wrong way.
 */
@Injectable()
export class MemberOtpService {
  private readonly logger = new Logger(MemberOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @Inject(OTP_DELIVERY) private readonly delivery: OtpDelivery,
  ) {}

  /** The spendable window for a code issued right now. */
  private get codeTtlMs(): number {
    return (
      this.config.get<number>('OTP_EXPIRY_SECONDS', DEFAULT_CODE_TTL_SECONDS) *
      1000
    );
  }

  /**
   * Always resolves the same way whatever it found.
   *
   * A number that belongs to nobody, a number already sent a code
   * moments ago, and a number that has just been messaged are
   * indistinguishable to the caller. Anything else turns this endpoint
   * into a membership list: point it at a range of numbers and read the
   * answers.
   *
   * The response is the same shape under every provider and never
   * carries the code — in production or out of it. A developer reads it
   * out of the mock provider's log line, a member off their handset.
   * Nobody reads it out of an HTTP response, because a response is the
   * one place somebody holding a phone number can see.
   */
  async requestCode(rawPhone: string, meta: OtpRequestMeta) {
    if (!this.delivery.isConfigured()) {
      // Configuration is about this deployment, not about the caller, so
      // it is the one thing worth saying plainly: a member staring at a
      // code that is never going to arrive has no way to know.
      throw new BadRequestException(
        'SMS login is not configured on this deployment',
      );
    }

    const generic = {
      sent: true as const,
      expiresInSeconds: this.codeTtlMs / 1000,
    };

    const last10 = phoneKey(rawPhone);
    if (!last10) return generic;

    // Matched on the last ten digits so a member typing 9876543210 finds
    // the record stored as +919876543210.
    const members = await this.prisma.member.findMany({
      where: { phone: { endsWith: last10 }, deletedAt: null },
      select: { id: true, phone: true, organizationId: true },
      take: 2,
    });

    if (members.length === 0) return generic;
    if (members.length > 1) {
      // Two people share this handset. Sending a code would log whoever
      // typed it into an account that may not be theirs, so nothing is
      // sent and staff have to resolve it.
      this.logger.warn(
        `SMS login requested for a number held by ${members.length} members; refusing to guess`,
      );
      return generic;
    }

    const member = members[0];
    const phone = member.phone!;

    const recent = await this.prisma.memberOtpChallenge.findFirst({
      where: {
        phone,
        createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) return generic;

    const sentToday = await this.prisma.memberOtpChallenge.count({
      where: { phone, createdAt: { gt: new Date(Date.now() - DAY_MS) } },
    });
    if (sentToday >= MAX_CODES_PER_DAY) {
      this.logger.warn(
        `SMS login code limit reached for member ${member.id}; not sending`,
      );
      return generic;
    }

    // randomInt is the CSPRNG; Math.random would make the code guessable
    // from a previous one. (Under OTP_PROVIDER=mock this is the fixed
    // MOCK_OTP instead, and is equally hashed and expiring -- the point
    // of the mock is to exercise this path, not to skip past it.)
    const code = this.delivery.issueCode();

    await this.prisma.memberOtpChallenge.create({
      data: {
        memberId: member.id,
        phone,
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + this.codeTtlMs),
      },
    });

    try {
      await this.delivery.send({
        to: phone,
        code,
        organizationId: member.organizationId,
      });
    } catch (error) {
      // The challenge row stays: it expires on its own, and deleting it
      // here would let a caller probe which numbers fail to send.
      this.logger.error(
        `Could not send a login code: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    await this.audit.record({
      organizationId: member.organizationId,
      action: 'member_otp_requested',
      resource: 'member',
      resourceId: member.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return generic;
  }

  /**
   * Spend a code.
   *
   * Returns the member and the user id to start a session for; the
   * caller issues the session, so this service never has to know how
   * tokens are minted.
   */
  async verifyCode(rawPhone: string, code: string, meta: OtpRequestMeta) {
    const invalid = new UnauthorizedException('That code is not valid');

    const last10 = phoneKey(rawPhone);
    if (!last10) throw invalid;

    const challenge = await this.prisma.memberOtpChallenge.findFirst({
      where: {
        phone: { endsWith: last10 },
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        member: {
          select: {
            id: true,
            organizationId: true,
            firstName: true,
            lastName: true,
            userId: true,
            deletedAt: true,
          },
        },
      },
    });

    // No live challenge, a spent one, an expired one and a wrong number
    // all answer identically.
    if (!challenge || challenge.member.deletedAt) throw invalid;

    // Count the guess before checking it, so a caller who disconnects
    // mid-request does not get a free attempt -- and check the budget in
    // the same write: reading it first let parallel guesses all pass the
    // check before any of them was counted.
    const counted = await this.prisma.memberOtpChallenge.updateMany({
      where: { id: challenge.id, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count !== 1) throw invalid;

    const supplied = hashCode(String(code ?? ''));
    const expected = challenge.codeHash;
    const matches =
      supplied.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!matches) throw invalid;

    // Single use, even inside the window -- and even for two requests
    // racing with the same code: only one of them spends it.
    const consumed = await this.prisma.memberOtpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid;

    const userId = await this.ensureMemberUser(challenge.member);

    await this.audit.record({
      organizationId: challenge.member.organizationId,
      actorUserId: userId,
      action: 'member_otp_login',
      resource: 'member',
      resourceId: challenge.member.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { userId, memberId: challenge.member.id };
  }

  /**
   * The login account behind a member, created on first successful code.
   *
   * Not an extra feature: none of the 954 members has a `User`, because
   * the only way to make one was an emailed invitation and they have no
   * email. Without this, a correct code would authenticate someone the
   * system still has no way to hold a session for.
   *
   * The account is created with no email and no password. It is reachable
   * only by proving possession of the phone again.
   */
  private async ensureMemberUser(member: {
    id: string;
    organizationId: string;
    firstName: string;
    lastName: string | null;
    userId: string | null;
  }): Promise<string> {
    if (member.userId) return member.userId;

    const role = await this.prisma.role.findFirst({
      where: {
        key: 'MEMBER',
        OR: [{ organizationId: member.organizationId }, { isSystem: true }],
      },
      select: { id: true },
    });
    if (!role) throw new BadRequestException('MEMBER role is not seeded');

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          organizationId: member.organizationId,
          email: null,
          firstName: member.firstName,
          lastName: member.lastName ?? '',
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      await tx.member.update({
        where: { id: member.id },
        data: { userId: user.id },
      });
      await tx.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
          organizationId: member.organizationId,
        },
      });
      return user.id;
    });
  }
}
