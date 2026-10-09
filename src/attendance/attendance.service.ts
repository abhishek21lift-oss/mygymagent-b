import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes } from 'crypto';
import {
  PaginationQueryDto,
  paginate,
  skipTake,
} from '../common/dto/pagination-query.dto';
import {
  DomainEvent,
  type AttendanceRecordedEvent,
} from '../events/domain-events';
import { PublicRateLimitService } from '../common/rate-limit/public-rate-limit.service';
import {
  organizationTimezone,
  startOfZonedDay,
  zonedBound,
} from '../common/time/zoned';
import { ConfigService } from '@nestjs/config';
import { FileStorageService } from '../files/file-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CheckInDto } from './dto/check-in.dto';
import type { DeviceKind } from '@prisma/client';
import {
  currentQrToken,
  freshQrCredential,
  qrTokenHash,
  qrTokenKey,
} from './member-qr-token';
import type { DeviceCheckInDto } from './dto/device-check-in.dto';
import type {
  CreateDeviceEnrolmentDto,
  ListDeviceEnrolmentsQueryDto,
} from './dto/device-enrolment.dto';

/**
 * A second allowed kiosk check-in by the same member on the same device
 * inside this window is the same visit -- a QR held in front of the camera
 * twice, a double tap -- and answers with the first record instead of
 * writing another.
 */
const KIOSK_REPEAT_WINDOW_MS = 60_000;

/**
 * Machine-readable twin of a denial `reason`. The reason strings are an
 * existing contract (turnstiles and the attendance list show them), so
 * they stay as they are; the code is what an unattended screen keys its
 * member-facing wording on, so it never has to parse English.
 */
export type GateDenialCode =
  'MEMBERSHIP_EXPIRED' | 'NO_ACTIVE_MEMBERSHIP' | 'PAYMENT_DUE';

export type KioskDenialCode =
  GateDenialCode | 'MEMBER_NOT_FOUND' | 'WRONG_BRANCH' | 'QR_INVALID';

/** What an enrolment looks like to an operator. The member is included
 * because an `externalUserId` on its own says nothing a human can act on. */
const ENROLMENT_SELECT = {
  id: true,
  branchId: true,
  externalUserId: true,
  memberId: true,
  createdAt: true,
  member: {
    select: { id: true, firstName: true, lastName: true, memberCode: true },
  },
} as const;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly rateLimit: PublicRateLimitService,
    private readonly files: FileStorageService,
    private readonly config: ConfigService,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    filters: {
      branchId?: string;
      memberId?: string;
      /** YYYY-MM-DD, a day in the gym's timezone. */
      date?: string;
      assignmentScope?: string | null;
    },
  ) {
    const timezone = filters.date
      ? await organizationTimezone(this.prisma, organizationId)
      : null;
    const where = {
      organizationId,
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(filters.memberId ? { memberId: filters.memberId } : {}),
      ...(filters.date && timezone
        ? {
            checkInAt: {
              gte: zonedBound(filters.date, timezone, 'from'),
              lt: zonedBound(filters.date, timezone, 'to'),
            },
          }
        : {}),
      ...(filters.assignmentScope
        ? { member: { assignedTrainerId: filters.assignmentScope } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.attendance.findMany({
        where,
        ...skipTake(query),
        orderBy: { checkInAt: query.order ?? 'desc' },
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              assignedTrainerId: true,
            },
          },
          staffUser: { select: { id: true, firstName: true, lastName: true } },
          // The name, not just the id. Every attendance row carries a
          // branch and the clients render one on each -- the member 360
          // attendance tab was showing a raw UUID for the branch of every
          // single visit, which is unreadable and tells an operator
          // nothing about which of their locations the member trains at.
          branch: { select: { id: true, name: true } },
        },
      }),
      this.prisma.attendance.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  /**
   * Turnstile-gated check-in. The gate runs BEFORE insert for member
   * check-ins (staff check-ins bypass it -- no membership to gate on):
   * an active membership covering now, and no OVERDUE invoice. A denial
   * still inserts a row carrying `deniedReason` and resolves
   * `{allowed:false, reason, attendanceId}` with HTTP 200 (the controller
   * sets the status) so turnstiles get a decision, not a 4xx. An allowed
   * check-in resolves `{allowed:true, ...record}` -- the spread keeps the
   * pre-WS-3 record shape (`id`, `branchId`, ...) for existing callers.
   */
  async checkIn(
    organizationId: string,
    recordedByUserId: string,
    dto: CheckInDto,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    let memberId = dto.memberId;
    const staffUserId = dto.staffUserId;

    if (dto.qrToken) {
      if (staffUserId) {
        throw new BadRequestException(
          'qrToken cannot be combined with staffUserId',
        );
      }
      memberId = await this.resolveMemberFromQrToken(
        organizationId,
        dto.qrToken,
      );
    }

    if (branchScope && dto.branchId && dto.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot check in a member/staff to a branch outside your assignment',
      );
    }
    if (!memberId && !staffUserId) {
      throw new BadRequestException(
        'Either memberId (or qrToken) or staffUserId is required',
      );
    }
    if (memberId && staffUserId) {
      throw new BadRequestException(
        'Provide only one of memberId or staffUserId',
      );
    }

    if (memberId) {
      const member = await this.prisma.member.findFirst({
        where: {
          id: memberId,
          organizationId,
          deletedAt: null,
          ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
        },
        select: { id: true, primaryBranchId: true },
      });
      if (!member) throw new NotFoundException('Member not found');
      const branchId = dto.branchId ?? member.primaryBranchId;
      if (branchScope && branchId !== branchScope) {
        throw new BadRequestException(
          'Cannot check in a member/staff to a branch outside your assignment',
        );
      }
      const branch = await this.prisma.branch.findFirst({
        where: { id: branchId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!branch) throw new NotFoundException('Branch not found');

      const method =
        dto.method ?? (dto.qrToken ? ('QR' as const) : ('MANUAL' as const));
      const gate = await this.evaluateGate(organizationId, memberId);
      const record = await this.prisma.attendance.create({
        data: {
          organizationId,
          branchId: branch.id,
          memberId,
          method,
          recordedByUserId,
          ...(gate.allowed ? {} : { deniedReason: gate.reason }),
        },
      });
      if (gate.allowed) {
        const payload: AttendanceRecordedEvent = {
          organizationId,
          branchId: record.branchId,
          attendanceId: record.id,
          memberId,
        };
        this.events.emit(DomainEvent.AttendanceRecorded, payload);
        return { allowed: true as const, ...record };
      }
      return {
        allowed: false as const,
        reason: gate.reason as string,
        attendanceId: record.id,
      };
    }

    // -- staff path (no gate) -------------------------------------------
    if (assignmentScope) {
      throw new BadRequestException(
        'Assigned trainers can only record attendance for their assigned members',
      );
    }
    if (!dto.branchId) {
      throw new BadRequestException('branchId is required for staff check-in');
    }
    const staff = await this.prisma.user.findFirst({
      where: { id: staffUserId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!staff) throw new NotFoundException('Staff user not found');

    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    const record = await this.prisma.attendance.create({
      data: {
        organizationId,
        branchId: dto.branchId,
        staffUserId,
        method: dto.method ?? 'MANUAL',
        recordedByUserId,
      },
    });
    const payload: AttendanceRecordedEvent = {
      organizationId,
      branchId: record.branchId,
      attendanceId: record.id,
      staffUserId,
    };
    this.events.emit(DomainEvent.AttendanceRecorded, payload);
    return { allowed: true as const, ...record };
  }

  /**
   * The shared turnstile decision. Membership first (must have an ACTIVE
   * row covering now), then invoices (no OVERDUE row). Returns the first
   * applicable denial reason, matching the spec's
   * "membership expired <date>" / "unpaid invoice <number>" shapes.
   */
  async evaluateGate(
    organizationId: string,
    memberId: string,
    now: Date = new Date(),
  ): Promise<{ allowed: boolean; reason?: string; code?: GateDenialCode }> {
    const active = await this.prisma.membership.findFirst({
      where: {
        organizationId,
        memberId,
        status: 'ACTIVE',
        startDate: { lte: now },
        endDate: { gte: now },
      },
      select: { id: true },
    });
    if (!active) {
      const latest = await this.prisma.membership.findFirst({
        where: { organizationId, memberId },
        orderBy: { endDate: 'desc' },
        select: { endDate: true },
      });
      return latest
        ? {
            allowed: false,
            reason: `membership expired ${latest.endDate.toISOString().slice(0, 10)}`,
            code: 'MEMBERSHIP_EXPIRED',
          }
        : {
            allowed: false,
            reason: 'no active membership',
            code: 'NO_ACTIVE_MEMBERSHIP',
          };
    }
    const overdue = await this.prisma.invoice.findFirst({
      where: { organizationId, memberId, status: 'OVERDUE' },
      select: { number: true },
      orderBy: { dueAt: 'asc' },
    });
    if (overdue) {
      return {
        allowed: false,
        reason: `unpaid invoice ${overdue.number}`,
        code: 'PAYMENT_DUE',
      };
    }
    return { allowed: true };
  }

  /**
   * The member's current entry code, the same one every time it is asked
   * for until it is rotated or reaches `rotatesAt`. Viewing a member at
   * the desk and opening the portal therefore never retire the code the
   * member is carrying; a new one is minted only when there is no usable
   * code (none yet, expired, or a row from before codes were readable).
   */
  async currentQrToken(
    organizationId: string,
    memberId: string,
    assignmentScope: string | null = null,
    branchScope: string | null = null,
  ): Promise<{ token: string; rotatesAt: string; memberId: string }> {
    const id = await this.qrTokenMember(
      organizationId,
      memberId,
      assignmentScope,
      branchScope,
    );
    const key = qrTokenKey(this.config);
    // Compare-and-swap rather than a plain upsert: two screens asking at
    // once must end up showing the same code, not one each with the
    // first already dead. A writer that loses re-reads the winner's row.
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.prisma.memberQrToken.findUnique({
        where: { memberId: id },
      });
      const token = row && currentQrToken(key, row);
      if (row && token) {
        return { token, rotatesAt: row.rotatesAt.toISOString(), memberId: id };
      }
      const fresh = freshQrCredential(key, id);
      const written = row
        ? await this.prisma.memberQrToken.updateMany({
            where: { memberId: id, tokenHash: row.tokenHash },
            data: fresh.data,
          })
        : await this.prisma.memberQrToken.createMany({
            data: [{ memberId: id, ...fresh.data }],
            skipDuplicates: true,
          });
      if (written.count === 1) {
        return {
          token: fresh.token,
          rotatesAt: fresh.data.rotatesAt.toISOString(),
          memberId: id,
        };
      }
    }
    throw new ConflictException('Entry code is being changed; try again');
  }

  /**
   * A new entry code, retiring the old one at once: for a lost phone, a
   * shared screenshot, or a printed card that walked off.
   */
  async rotateQrToken(
    organizationId: string,
    memberId: string,
    assignmentScope: string | null = null,
    branchScope: string | null = null,
  ): Promise<{ token: string; rotatesAt: string; memberId: string }> {
    const id = await this.qrTokenMember(
      organizationId,
      memberId,
      assignmentScope,
      branchScope,
    );
    const fresh = freshQrCredential(qrTokenKey(this.config), id);
    await this.prisma.memberQrToken.upsert({
      where: { memberId: id },
      create: { memberId: id, ...fresh.data },
      update: fresh.data,
    });
    return {
      token: fresh.token,
      rotatesAt: fresh.data.rotatesAt.toISOString(),
      memberId: id,
    };
  }

  /**
   * Both routes hand out a working entry credential, so both respect
   * assignment and branch scope like any other member-addressed route: an
   * assignment-scoped caller asking for a member who isn't theirs, or a
   * branch-scoped one asking for a member whose home branch is another,
   * gets the same "not found" as if the member were in another org.
   */
  private async qrTokenMember(
    organizationId: string,
    memberId: string,
    assignmentScope: string | null,
    branchScope: string | null = null,
  ): Promise<string> {
    const member = await this.prisma.member.findFirst({
      where: {
        id: memberId,
        organizationId,
        deletedAt: null,
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
        ...(branchScope ? { primaryBranchId: branchScope } : {}),
      },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member.id;
  }

  /**
   * Resolves a presented QR token to its member. Unknown hashes and
   * past-`rotatesAt` rows both reject with 410 Gone (the credential was
   * rotated or never existed) -- never 404, so callers cannot probe which
   * member ids have tokens.
   */
  private async resolveMemberFromQrToken(
    organizationId: string,
    qrToken: string,
  ): Promise<string> {
    // Looked up by its unique hash. This used to load the first 5000
    // token rows platform-wide and compare each one, so once more than
    // 5000 members across every gym had a code, the rest were silently
    // refused at the desk as "unknown". Comparing in constant time bought
    // nothing: what is indexed is a sha256 of 32 random bytes, so timing
    // the lookup cannot walk anyone toward a valid token.
    const row = await this.prisma.memberQrToken.findUnique({
      where: { tokenHash: qrTokenHash(qrToken) },
      select: { memberId: true, rotatesAt: true },
    });
    if (row) {
      const member = await this.prisma.member.findFirst({
        where: { id: row.memberId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (member) {
        if (row.rotatesAt.getTime() <= Date.now()) {
          throw new GoneException('QR token has been rotated');
        }
        return member.id;
      }
    }
    throw new GoneException('Unknown or rotated QR token');
  }

  /**
   * Biometric device ingest. The branch `deviceKey` IS the credential (no
   * JWT); it is compared timing-safe. Always resolves to a 200 decision:
   * unknown external ids return `{allowed:false, reason:"unenrolled device
   * user"}` with no Attendance row (no member to attach it to), since
   * devices retry on non-200.
   */
  /**
   * The single place a device-originated check-in becomes an attendance
   * record. Both the biometric turnstile and the kiosk come through here,
   * so a row written by one is indistinguishable from the other to the
   * live view, the reports and the domain event -- which is the whole
   * point of B-P0-5.
   *
   * Denied attempts are recorded too: the gate refusing someone is
   * information the front desk needs, and dropping it was how the old
   * kiosk path left no trace of a turned-away member.
   */
  private async recordDeviceCheckIn(input: {
    organizationId: string;
    branchId: string;
    memberId: string;
    method: 'KIOSK' | 'BIOMETRIC';
    at: Date;
    deviceId?: string | null;
  }) {
    const gate = await this.evaluateGate(
      input.organizationId,
      input.memberId,
      input.at,
    );
    const record = await this.prisma.attendance.create({
      data: {
        organizationId: input.organizationId,
        branchId: input.branchId,
        memberId: input.memberId,
        method: input.method,
        checkInAt: input.at,
        deviceId: input.deviceId ?? null,
        ...(gate.allowed ? {} : { deniedReason: gate.reason }),
      },
    });
    if (gate.allowed) {
      const payload: AttendanceRecordedEvent = {
        organizationId: input.organizationId,
        branchId: input.branchId,
        attendanceId: record.id,
        memberId: input.memberId,
      };
      this.events.emit(DomainEvent.AttendanceRecorded, payload);
    }
    return { gate, record };
  }

  /**
   * Registers a device -- kiosk or biometric turnstile -- and returns its
   * key exactly once.
   *
   * The key is per-device and stored only as a sha256 hash, so one device
   * can be revoked without re-keying anything else. Before B-P0-13 the
   * turnstile instead used `Branch.deviceKey`: one plaintext secret shared
   * by every scanner on the branch, with no rotation and no per-device
   * revocation -- and, as it turned out, no write path either, so the
   * route it guarded could never authenticate.
   */
  async registerDevice(
    organizationId: string,
    input: { branchId: string; name: string; kind?: DeviceKind },
    branchScope: string | null = null,
  ) {
    // A branch-scoped manager administers their own branch's hardware
    // only; a key minted into another branch would let them stand up a
    // scanner that admits people there.
    if (branchScope && input.branchId !== branchScope) {
      throw new BadRequestException(
        'Cannot register a device outside your assigned branch',
      );
    }
    const branch = await this.prisma.branch.findFirst({
      where: { id: input.branchId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    const key = randomBytes(32).toString('hex');
    const device = await this.prisma.kioskDevice.create({
      data: {
        organizationId,
        branchId: branch.id,
        name: input.name.trim(),
        kind: input.kind ?? 'KIOSK',
        keyHash: sha256Hex(key),
      },
      select: {
        id: true,
        name: true,
        kind: true,
        branchId: true,
        active: true,
        createdAt: true,
      },
    });
    return {
      ...device,
      key,
      warning: 'Store this key securely; it is shown once.',
    };
  }

  /**
   * The registry as an operator sees it. Never selects `keyHash`: there is
   * no legitimate reason for a key digest to leave the database, and a
   * listing endpoint is precisely where one would leak by accident.
   */
  async listDevices(
    organizationId: string,
    query: { branchId?: string } = {},
    branchScope: string | null = null,
  ) {
    const branchId = branchScope ?? query.branchId;
    const items = await this.prisma.kioskDevice.findMany({
      where: { organizationId, ...(branchId ? { branchId } : {}) },
      select: {
        id: true,
        name: true,
        kind: true,
        branchId: true,
        active: true,
        revokedAt: true,
        createdAt: true,
      },
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
    });
    return { items };
  }

  /**
   * Revokes one device's key. Deactivation rather than deletion: the
   * attendance rows the device recorded stay attributable to it, which is
   * the point of keeping `Attendance.deviceId`. Idempotent -- revoking an
   * already-revoked device is a no-op, not an error, because the operator
   * doing it is trying to be sure.
   */
  async revokeDevice(
    organizationId: string,
    deviceId: string,
    branchScope: string | null = null,
  ) {
    // Another branch's device reads as "not found", same as another org's.
    const device = await this.prisma.kioskDevice.findFirst({
      where: {
        id: deviceId,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
      },
      select: { id: true, active: true },
    });
    if (!device) throw new NotFoundException('Device not found');
    if (!device.active) {
      return this.prisma.kioskDevice.findUniqueOrThrow({
        where: { id: device.id },
        select: {
          id: true,
          name: true,
          kind: true,
          branchId: true,
          active: true,
          revokedAt: true,
        },
      });
    }
    return this.prisma.kioskDevice.update({
      where: { id: device.id },
      data: { active: false, revokedAt: new Date() },
      select: {
        id: true,
        name: true,
        kind: true,
        branchId: true,
        active: true,
        revokedAt: true,
      },
    });
  }

  /**
   * Self-service kiosk ingest. The kiosk's own key is the credential --
   * per-device and stored only as a hash, so a single kiosk can be
   * revoked (`active = false`) without re-keying the branch.
   *
   * Before B-P0-5 this lived in BusinessOsService and wrote only to a
   * `kiosk_events` table that nothing read, so a member who checked in at
   * a kiosk never appeared in attendance at all.
   */
  async kioskCheckIn(input: {
    deviceKey: string;
    memberId?: string;
    memberCode?: string;
    qrToken?: string;
    clientKey: string;
    at?: Date;
  }) {
    const identifiers = [input.memberId, input.memberCode, input.qrToken]
      .map((value) => value?.trim())
      .filter((value): value is string => !!value);
    if (!input.deviceKey || identifiers.length !== 1) {
      throw new BadRequestException(
        'deviceKey and exactly one of memberId, memberCode or qrToken are required',
      );
    }
    await this.rateLimit.consume('kiosk-checkin', input.clientKey, 60, 60);

    const device = await this.resolveDevice(input.deviceKey, 'KIOSK');

    let memberId: string | null;
    if (input.qrToken?.trim()) {
      // The front desk's own resolver: hashed lookup, scoped to the
      // device's organization, refusing a rotated code. Its 410 is the
      // right answer for staff; an unattended screen needs a decision.
      try {
        memberId = await this.resolveMemberFromQrToken(
          device.organizationId,
          input.qrToken.trim(),
        );
      } catch (error) {
        if (!(error instanceof GoneException)) throw error;
        return {
          allowed: false as const,
          reason: 'qr code not recognised',
          code: 'QR_INVALID' as KioskDenialCode,
        };
      }
    } else if (input.memberCode?.trim()) {
      memberId = await this.findMemberIdByCode(
        device.organizationId,
        input.memberCode.trim(),
      );
    } else {
      memberId = input.memberId!.trim();
    }

    const member = memberId
      ? await this.prisma.member.findFirst({
          where: {
            id: memberId,
            organizationId: device.organizationId,
            deletedAt: null,
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            primaryBranchId: true,
          },
        })
      : null;
    // No attendance row for an unknown member: there is no member to
    // attach it to, and the old code's attempt to log one anyway violated
    // a foreign key and turned a clean denial into a 500.
    if (!member) {
      return {
        allowed: false as const,
        reason: 'member not found',
        code: 'MEMBER_NOT_FOUND' as KioskDenialCode,
      };
    }
    if (member.primaryBranchId !== device.branchId) {
      return {
        allowed: false as const,
        reason: 'member is assigned to a different branch',
        code: 'WRONG_BRANCH' as KioskDenialCode,
      };
    }

    const memberView = {
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
    };
    const at = input.at ?? new Date();

    const recent = await this.prisma.attendance.findFirst({
      where: {
        organizationId: device.organizationId,
        memberId: member.id,
        deviceId: device.id,
        deniedReason: null,
        checkInAt: { gte: new Date(at.getTime() - KIOSK_REPEAT_WINDOW_MS) },
      },
      orderBy: { checkInAt: 'desc' },
      select: { id: true, checkInAt: true },
    });
    if (recent) {
      return {
        allowed: true as const,
        attendanceId: recent.id,
        checkedInAt: recent.checkInAt,
        repeat: true,
        member: memberView,
      };
    }

    const { gate, record } = await this.recordDeviceCheckIn({
      organizationId: device.organizationId,
      branchId: device.branchId,
      memberId: member.id,
      method: 'KIOSK',
      at,
      deviceId: device.id,
    });

    if (!gate.allowed) {
      return {
        allowed: false as const,
        reason: gate.reason as string,
        code: gate.code as KioskDenialCode,
        attendanceId: record.id,
      };
    }
    return {
      allowed: true as const,
      attendanceId: record.id,
      checkedInAt: record.checkInAt,
      member: memberView,
    };
  }

  /**
   * Who a kiosk is: its own name, the branch it admits members to and the
   * gym it belongs to, for the screen to show. Nothing about any member,
   * and never the key or its digest. A revoked or unknown key is the same
   * 401 as on check-in, which is how a kiosk learns it was disconnected.
   */
  async kioskSession(input: { deviceKey: string; clientKey: string }) {
    await this.rateLimit.consume('kiosk-session', input.clientKey, 30, 60);
    const device = await this.resolveDevice(input.deviceKey, 'KIOSK');
    const row = await this.prisma.kioskDevice.findUniqueOrThrow({
      where: { id: device.id },
      select: {
        id: true,
        name: true,
        branch: { select: { id: true, name: true, timezone: true } },
        organization: { select: { name: true, logoKey: true } },
      },
    });
    const logoUrl = row.organization.logoKey
      ? await this.files
          .getSignedUrl(row.organization.logoKey)
          .catch(() => null)
      : null;
    return {
      device: { id: row.id, name: row.name },
      branch: row.branch,
      organization: { name: row.organization.name, logoUrl },
    };
  }

  /**
   * The member code printed on a card, matched within one organization.
   * Exact first; then case-insensitively, but only when that names a
   * single member -- a typed `m-000012` should work, an ambiguous match
   * should not pick someone. Bare digits are also tried in the shape
   * `generateMemberCode` issues (`12` -> `M-000012`), after the exact
   * match, so a gym that imported its own numeric codes still gets those.
   */
  private async findMemberIdByCode(
    organizationId: string,
    memberCode: string,
  ): Promise<string | null> {
    const exact = await this.prisma.member.findFirst({
      where: { organizationId, memberCode, deletedAt: null },
      select: { id: true },
    });
    if (exact) return exact.id;
    const loose = await this.prisma.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
        memberCode: { equals: memberCode, mode: 'insensitive' },
      },
      select: { id: true },
      take: 2,
    });
    if (loose.length === 1) return loose[0].id;
    if (/^\d{1,6}$/.test(memberCode)) {
      const issued = await this.prisma.member.findFirst({
        where: {
          organizationId,
          deletedAt: null,
          memberCode: `M-${memberCode.padStart(6, '0')}`,
        },
        select: { id: true },
      });
      return issued?.id ?? null;
    }
    return null;
  }

  /**
   * Enrols a member on a branch's turnstiles (B-P1-8).
   *
   * `DeviceMap` had no write path at all -- no endpoint, no import, no
   * seed -- so `deviceCheckIn` below found no mapping for anybody and
   * every biometric check-in answered `{allowed:false, reason:
   * "unenrolled device user"}` forever. B-P0-5 registered the controller
   * so the route existed; B-P0-13 gave the turnstile a credential it
   * could actually present; this is the last missing piece, the surface
   * that says which person a scanner's id belongs to.
   */
  async createEnrolment(
    organizationId: string,
    dto: CreateDeviceEnrolmentDto,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    if (branchScope && branchScope !== dto.branchId) {
      throw new NotFoundException('Branch not found');
    }
    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    // Same rule as `qrTokenMember`: this grants entry to the
    // building, so an assignment-scoped caller naming a member who is not
    // theirs gets the same "not found" as if the member were in another
    // organization.
    const member = await this.prisma.member.findFirst({
      where: {
        id: dto.memberId,
        organizationId,
        deletedAt: null,
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Member not found');

    const externalUserId = dto.externalUserId.trim();
    if (!externalUserId) {
      throw new BadRequestException('externalUserId is required');
    }

    const existing = await this.prisma.deviceMap.findFirst({
      where: { organizationId, branchId: branch.id, externalUserId },
      select: { id: true, memberId: true },
    });
    if (existing) {
      // Re-enrolling the same person on the same id is a no-op, because
      // the operator doing it is making sure. Re-pointing an id at a
      // *different* member is refused rather than upserted: scanners
      // reuse ids when someone is removed from the hardware, and silently
      // transferring building access from one member to another is not
      // something an enrolment call should be able to do by accident.
      // Remove the old mapping first, deliberately.
      if (existing.memberId !== member.id) {
        throw new ConflictException(
          'That device user id is already enrolled to a different member at this branch',
        );
      }
      return this.prisma.deviceMap.findUniqueOrThrow({
        where: { id: existing.id },
        select: ENROLMENT_SELECT,
      });
    }

    return this.prisma.deviceMap.create({
      data: {
        organizationId,
        branchId: branch.id,
        memberId: member.id,
        externalUserId,
      },
      select: ENROLMENT_SELECT,
    });
  }

  listEnrolments(
    organizationId: string,
    query: ListDeviceEnrolmentsQueryDto = {},
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    return this.prisma.deviceMap.findMany({
      where: {
        organizationId,
        ...((branchScope ?? query.branchId)
          ? { branchId: branchScope ?? query.branchId }
          : {}),
        ...(query.memberId ? { memberId: query.memberId } : {}),
        ...(assignmentScope
          ? { member: { assignedTrainerId: assignmentScope } }
          : {}),
      },
      select: ENROLMENT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Removes an enrolment, which is how a member loses door access. A hard
   * delete, unlike a revoked device: the row is the mapping itself, it
   * carries no history worth keeping, and the attendance it produced
   * references the member directly.
   */
  async deleteEnrolment(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const existing = await this.prisma.deviceMap.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
        ...(assignmentScope
          ? { member: { assignedTrainerId: assignmentScope } }
          : {}),
      },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Enrolment not found');
    await this.prisma.deviceMap.delete({ where: { id: existing.id } });
    return { deleted: true };
  }

  async deviceCheckIn(dto: DeviceCheckInDto) {
    const device = await this.resolveDevice(dto.deviceKey, 'BIOMETRIC');
    const mapping = await this.prisma.deviceMap.findFirst({
      where: {
        organizationId: device.organizationId,
        branchId: device.branchId,
        externalUserId: dto.externalUserId,
      },
      select: { memberId: true },
    });
    if (!mapping) {
      return { allowed: false as const, reason: 'unenrolled device user' };
    }
    const member = await this.prisma.member.findFirst({
      where: {
        id: mapping.memberId,
        organizationId: device.organizationId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!member) {
      return { allowed: false as const, reason: 'unenrolled device user' };
    }
    const at = dto.at ? new Date(dto.at) : new Date();
    if (Number.isNaN(at.getTime())) {
      throw new BadRequestException('Invalid at timestamp');
    }
    const { gate, record } = await this.recordDeviceCheckIn({
      organizationId: device.organizationId,
      branchId: device.branchId,
      memberId: member.id,
      method: 'BIOMETRIC',
      at,
      // Attribution the branch-key path could not provide: with one key
      // per branch there was no device to name, so every turnstile row
      // was written with a null deviceId.
      deviceId: device.id,
    });
    if (gate.allowed) return { allowed: true as const, ...record };
    return {
      allowed: false as const,
      reason: gate.reason as string,
      attendanceId: record.id,
    };
  }

  /**
   * The one place a presented device key becomes a device (B-P0-13).
   *
   * Looked up by digest on a unique index, so the plaintext key is never
   * stored and never compared: a wrong key finds no row at all, which is
   * both cheaper and less leaky than the old scan-and-compare over branch
   * keys. `kind` is part of the match rather than a check afterwards -- a
   * kiosk key presented at the turnstile is simply not a device, the same
   * 401 as a key that was never issued, and the two routes cannot be used
   * to probe each other's registry.
   */
  private async resolveDevice(deviceKey: string, kind: DeviceKind) {
    if (!deviceKey) throw new UnauthorizedException('Invalid device key');
    const device = await this.prisma.kioskDevice.findFirst({
      where: { keyHash: sha256Hex(deviceKey), kind, active: true },
      select: { id: true, organizationId: true, branchId: true },
    });
    if (!device) throw new UnauthorizedException('Invalid device key');
    return device;
  }

  /**
   * Live turnstile view: members currently inside (today's check-in with no
   * check-out, allowed rows only) plus today's denied attempts. Branch
   * scope folds into both lists the same way `list()` does.
   */
  async live(
    organizationId: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const now = new Date();
    // The gym's today, not UTC's, which starts at 05:30 in India.
    const startOfToday = startOfZonedDay(
      now,
      await organizationTimezone(this.prisma, organizationId),
    );
    const scope = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
      ...(assignmentScope
        ? { member: { assignedTrainerId: assignmentScope } }
        : {}),
    };
    const [inside, denied] = await Promise.all([
      this.prisma.attendance.findMany({
        where: {
          ...scope,
          checkInAt: { gte: startOfToday },
          checkOutAt: null,
          deniedReason: null,
          memberId: { not: null },
        },
        orderBy: { checkInAt: 'desc' },
        include: {
          member: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.attendance.findMany({
        where: {
          ...scope,
          checkInAt: { gte: startOfToday },
          deniedReason: { not: null },
        },
        orderBy: { checkInAt: 'desc' },
        include: {
          member: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
    ]);
    return { inside, denied, generatedAt: now.toISOString() };
  }

  async checkOut(
    organizationId: string,
    id: string,
    branchScope: string | null = null,
    assignmentScope: string | null = null,
  ) {
    const record = await this.prisma.attendance.findFirst({
      where: {
        id,
        organizationId,
        ...(branchScope ? { branchId: branchScope } : {}),
        ...(assignmentScope
          ? { member: { assignedTrainerId: assignmentScope } }
          : {}),
      },
    });
    if (!record) throw new NotFoundException('Attendance record not found');
    if (record.checkOutAt) throw new BadRequestException('Already checked out');
    return this.prisma.attendance.update({
      where: { id },
      data: { checkOutAt: new Date() },
    });
  }
}
