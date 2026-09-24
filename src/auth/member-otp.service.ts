import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Msg91SmsProvider } from '../communications/providers/msg91-sms.provider';
import { phoneKey } from '../data/customer-enquiry-mapping';

export interface OtpRequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

/** Long enough to type from a notification, short enough that guessing
 * inside the window is hopeless at five attempts. */
const CODE_DIGITS = 6;
const CODE_TTL_MS = 5 * 60_000;
/** Wrong guesses allowed against one issued code before it is spent. */
const MAX_ATTEMPTS = 5;
/** A second request inside this window reuses nothing and sends nothing,
 * so a hostile caller cannot bill the gym for SMS or flood a member's
 * handset by holding down a button. */
const RESEND_COOLDOWN_MS = 60_000;

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
 * The code is generated, hashed, expired and counted here. MSG91 only
 * carries it -- see `Msg91SmsProvider` for why its OTP endpoint is not
 * used.
 */
@Injectable()
export class MemberOtpService {
  private readonly logger = new Logger(MemberOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sms: Msg91SmsProvider,
  ) {}

  /**
   * Always resolves the same way whatever it found.
   *
   * A number that belongs to nobody, a number already sent a code
   * moments ago, and a number that has just been messaged are
   * indistinguishable to the caller. Anything else turns this endpoint
   * into a membership list: point it at a range of numbers and read the
   * answers.
   */
  async requestCode(rawPhone: string, meta: OtpRequestMeta) {
    if (!this.sms.isConfigured()) {
      // Configuration is about this deployment, not about the caller, so
      // it is the one thing worth saying plainly: a member staring at a
      // code that is never going to arrive has no way to know.
      throw new BadRequestException(
        'SMS login is not configured on this deployment',
      );
    }

    const generic = {
      sent: true as const,
      expiresInSeconds: CODE_TTL_MS / 1000,
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

    // randomInt is the CSPRNG; Math.random would make the code guessable
    // from a previous one.
    const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(
      CODE_DIGITS,
      '0',
    );

    await this.prisma.memberOtpChallenge.create({
      data: {
        memberId: member.id,
        phone,
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });

    try {
      await this.sms.send({
        to: phone,
        text: code,
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

    if (challenge.attempts >= MAX_ATTEMPTS) throw invalid;

    // Count the guess before checking it, so a caller who disconnects
    // mid-request does not get a free attempt.
    await this.prisma.memberOtpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });

    const supplied = hashCode(String(code ?? ''));
    const expected = challenge.codeHash;
    const matches =
      supplied.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!matches) throw invalid;

    // Single use, even inside the window.
    await this.prisma.memberOtpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });

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
