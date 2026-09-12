import {
  BadRequestException,
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
import { PrismaService } from '../prisma/prisma.service';
import type { CheckInDto } from './dto/check-in.dto';
import type { DeviceCheckInDto } from './dto/device-check-in.dto';

const QR_VALIDITY_DAYS = 30;

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
    let staffUserId = dto.staffUserId;

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
  ): Promise<{ token: string; rotatesAt: string; memberId: string }> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId, deletedAt: null },
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
  async deviceCheckIn(dto: DeviceCheckInDto) {
    const branch = await this.resolveBranchFromDeviceKey(dto.deviceKey);
    const mapping = await this.prisma.deviceMap.findFirst({
      where: {
        organizationId: branch.organizationId,
        branchId: branch.id,
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
        organizationId: branch.organizationId,
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
    const gate = await this.evaluateGate(
      branch.organizationId,
      member.id,
      at,
    );
    const record = await this.prisma.attendance.create({
      data: {
        organizationId: branch.organizationId,
        branchId: branch.id,
        memberId: member.id,
        method: 'BIOMETRIC',
        checkInAt: at,
        ...(gate.allowed ? {} : { deniedReason: gate.reason }),
      },
    });
    if (gate.allowed) {
      const payload: AttendanceRecordedEvent = {
        organizationId: branch.organizationId,
        branchId: branch.id,
        attendanceId: record.id,
        memberId: member.id,
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

  private async resolveBranchFromDeviceKey(deviceKey: string) {
    if (!deviceKey) throw new UnauthorizedException('Invalid device key');
    const branches = await this.prisma.branch.findMany({
      where: { deviceKey: { not: null }, deletedAt: null },
      select: { id: true, organizationId: true, deviceKey: true },
    });
    for (const branch of branches) {
      if (branch.deviceKey && safeEqual(branch.deviceKey, deviceKey)) {
        return branch;
      }
    }
    throw new UnauthorizedException('Invalid device key');
  }

  /**
   * Live turnstile view: members currently inside (today's check-in with no
   * check-out, allowed rows only) plus today's denied attempts. Branch
   * scope folds into both lists the same way `list()` does.
   */
  async live(organizationId: string, branchScope: string | null = null) {
    const now = new Date();
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const scope = {
      organizationId,
      ...(branchScope ? { branchId: branchScope } : {}),
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
