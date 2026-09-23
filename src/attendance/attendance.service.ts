import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
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
import { PrismaService } from '../prisma/prisma.service';
import type { CheckInDto } from './dto/check-in.dto';
import type { DeviceKind } from '@prisma/client';
import type { DeviceCheckInDto } from './dto/device-check-in.dto';
import type {
  CreateDeviceEnrolmentDto,
  ListDeviceEnrolmentsQueryDto,
} from './dto/device-enrolment.dto';

const QR_VALIDITY_DAYS = 30;

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

/** Constant-time string comparison so token/key guesses leak nothing measurable. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly rateLimit: PublicRateLimitService,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
    filters: {
      branchId?: string;
      memberId?: string;
      assignmentScope?: string | null;
    },
  ) {
    const where = {
      organizationId,
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(filters.memberId ? { memberId: filters.memberId } : {}),
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
  ): Promise<{ allowed: boolean; reason?: string }> {
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
      return {
        allowed: false,
        reason: latest
          ? `membership expired ${latest.endDate.toISOString().slice(0, 10)}`
          : 'no active membership',
      };
    }
    const overdue = await this.prisma.invoice.findFirst({
      where: { organizationId, memberId, status: 'OVERDUE' },
      select: { number: true },
      orderBy: { dueAt: 'asc' },
    });
    if (overdue) {
      return { allowed: false, reason: `unpaid invoice ${overdue.number}` };
    }
    return { allowed: true };
  }

  /**
   * QR credential: always (re)generates. The plaintext token is returned
   * once here and never stored -- only its sha256 hash persists. Callers
   * must surface `token` to the member immediately (QR render); a later
   * GET cannot recover the same value, it mints a new one.
   */
  async getOrRotateQrToken(
    organizationId: string,
    memberId: string,
    assignmentScope: string | null = null,
  ): Promise<{ token: string; rotatesAt: string; memberId: string }> {
    // This mints a working entry credential, so it must respect assignment
    // scope like any other member-addressed route: an assignment-scoped
    // caller asking for a member who isn't theirs gets the same "not found"
    // as if the member were in another org, never a usable token.
    const member = await this.prisma.member.findFirst({
      where: {
        id: memberId,
        organizationId,
        deletedAt: null,
        ...(assignmentScope ? { assignedTrainerId: assignmentScope } : {}),
      },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    const token = randomBytes(32).toString('hex');
    const rotatesAt = new Date(
      Date.now() + QR_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    );
    await this.prisma.memberQrToken.upsert({
      where: { memberId: member.id },
      create: { memberId: member.id, tokenHash: sha256Hex(token), rotatesAt },
      update: { tokenHash: sha256Hex(token), rotatesAt },
    });
    return { token, rotatesAt: rotatesAt.toISOString(), memberId: member.id };
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
    const presentedHash = sha256Hex(qrToken);
    const candidates = await this.prisma.memberQrToken.findMany({
      select: { memberId: true, tokenHash: true, rotatesAt: true },
      take: 5000,
    });
    for (const row of candidates) {
      if (!safeEqual(row.tokenHash, presentedHash)) continue;
      const member = await this.prisma.member.findFirst({
        where: { id: row.memberId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!member) break;
      if (row.rotatesAt.getTime() <= Date.now()) {
        throw new GoneException('QR token has been rotated');
      }
      return member.id;
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
  ) {
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
  async revokeDevice(organizationId: string, deviceId: string) {
    const device = await this.prisma.kioskDevice.findFirst({
      where: { id: deviceId, organizationId },
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
    memberId: string;
    clientKey: string;
    at?: Date;
  }) {
    if (!input.deviceKey || !input.memberId) {
      throw new BadRequestException('deviceKey and memberId are required');
    }
    await this.rateLimit.consume('kiosk-checkin', input.clientKey, 60, 60);

    const device = await this.resolveDevice(input.deviceKey, 'KIOSK');

    const member = await this.prisma.member.findFirst({
      where: {
        id: input.memberId,
        organizationId: device.organizationId,
        deletedAt: null,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        primaryBranchId: true,
      },
    });
    // No attendance row for an unknown member: there is no member to
    // attach it to, and the old code's attempt to log one anyway violated
    // a foreign key and turned a clean denial into a 500.
    if (!member) {
      return { allowed: false as const, reason: 'member not found' };
    }
    if (member.primaryBranchId !== device.branchId) {
      return {
        allowed: false as const,
        reason: 'member is assigned to a different branch',
      };
    }

    const { gate, record } = await this.recordDeviceCheckIn({
      organizationId: device.organizationId,
      branchId: device.branchId,
      memberId: member.id,
      method: 'KIOSK',
      at: input.at ?? new Date(),
      deviceId: device.id,
    });

    if (!gate.allowed) {
      return {
        allowed: false as const,
        reason: gate.reason as string,
        attendanceId: record.id,
      };
    }
    return {
      allowed: true as const,
      attendanceId: record.id,
      member: {
        id: member.id,
        firstName: member.firstName,
        lastName: member.lastName,
      },
    };
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

    // Same rule as `getOrRotateQrToken`: this grants entry to the
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
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
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
