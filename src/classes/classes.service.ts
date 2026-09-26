import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateClassProgramDto,
  CreateClassSessionDto,
  ListClassSessionsDto,
  ListClassesDto,
} from './dto/classes.dto';

const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_ANALYTICS_DAYS = 30;
const DAY_MS = 86_400_000;

/** The statuses that occupy a place or a queue position. Re-booking one of
 * these is a conflict; re-booking anything else revives the row. */
const LIVE_STATUSES = ['BOOKED', 'WAITLISTED'] as const;

/** The client handed to a `$transaction` callback: the same model API
 * minus the lifecycle methods. Named so the two helpers below read the
 * same whether they are called inside a transaction or not. */
type PrismaTx = Prisma.TransactionClient;

/**
 * Tenant-scoped group training orchestration.
 *
 * B-P0-8: this module used to reach `class_programs`, `class_sessions` and
 * `class_bookings` exclusively through `$queryRawUnsafe`, with no Prisma
 * model behind any of them. The SQL was correct -- unlike the Business OS
 * case in B-P0-1 it quoted its camelCase columns -- so this port is about
 * type safety and drift visibility, not a live bug: nothing checked that a
 * selected column existed, and `prisma migrate diff` could not see three
 * tables at all.
 *
 * Two things did change behaviourally, both deliberate, both noted where
 * they happen: `cancel()` now takes the same advisory lock `book()` does,
 * and `updatedAt` is maintained by Prisma rather than written by hand.
 */
@Injectable()
export class ClassesService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertBranch(organizationId: string, id: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id, organizationId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    if (!branch) {
      throw new BadRequestException(
        'Branch does not belong to this organization',
      );
    }
  }

  private async assertInstructor(organizationId: string, id?: string | null) {
    if (!id) return;
    const user = await this.prisma.user.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException(
        'Instructor does not belong to this organization',
      );
    }
  }

  private async assertMember(organizationId: string, id: string) {
    const member = await this.prisma.member.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!member) {
      throw new BadRequestException(
        'Member does not belong to this organization',
      );
    }
  }

  async programs(organizationId: string, query: ListClassesDto) {
    const rows = await this.prisma.classProgram.findMany({
      where: {
        organizationId,
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: {
        branch: { select: { name: true } },
        instructor: { select: { firstName: true, lastName: true } },
      },
      orderBy: { name: 'asc' },
    });
    // The raw version flattened the joins into `branchName` /
    // `instructorFirstName` / `instructorLastName`; keep that shape so the
    // response contract is unchanged by the port.
    return rows.map(({ branch, instructor, ...program }) => ({
      ...program,
      branchName: branch.name,
      instructorFirstName: instructor?.firstName ?? null,
      instructorLastName: instructor?.lastName ?? null,
    }));
  }

  async createProgram(organizationId: string, dto: CreateClassProgramDto) {
    await this.assertBranch(organizationId, dto.branchId);
    await this.assertInstructor(organizationId, dto.instructorId);
    return this.prisma.classProgram.create({
      data: {
        organizationId,
        branchId: dto.branchId,
        name: dto.name.trim(),
        description: dto.description ?? null,
        capacity: dto.capacity,
        durationMinutes: dto.durationMinutes,
        instructorId: dto.instructorId ?? null,
      },
    });
  }

  async sessions(organizationId: string, query: ListClassSessionsDto) {
    const from = query.from ? new Date(query.from) : new Date();
    const to = query.to
      ? new Date(query.to)
      : new Date(from.getTime() + DEFAULT_WINDOW_DAYS * DAY_MS);
    if (!(from < to)) throw new BadRequestException('to must be after from');

    const sessions = await this.prisma.classSession.findMany({
      where: {
        organizationId,
        startTime: { gte: from, lte: to },
        ...(query.branchId ? { branchId: query.branchId } : {}),
      },
      include: {
        classProgram: {
          select: {
            name: true,
            capacity: true,
            instructorId: true,
            instructor: { select: { firstName: true, lastName: true } },
          },
        },
        branch: { select: { name: true } },
        instructor: { select: { firstName: true, lastName: true } },
      },
      orderBy: { startTime: 'asc' },
    });

    // The instructor filter is COALESCE(session, program) -- a session
    // without its own instructor is led by the program's -- which is not
    // expressible as a `where` on either column alone.
    const filtered = query.instructorId
      ? sessions.filter(
          (s) =>
            (s.instructorId ?? s.classProgram.instructorId) ===
            query.instructorId,
        )
      : sessions;
    if (!filtered.length) return [];

    const counts = await this.countsBySession(filtered.map((s) => s.id));

    return filtered.map(({ classProgram, branch, instructor, ...session }) => {
      const lead = instructor ?? classProgram.instructor;
      const tally = counts.get(session.id);
      return {
        ...session,
        className: classProgram.name,
        branchName: branch.name,
        effectiveCapacity: session.capacity ?? classProgram.capacity,
        instructorFirstName: lead?.firstName ?? null,
        instructorLastName: lead?.lastName ?? null,
        bookedCount: tally?.BOOKED ?? 0,
        waitlistCount: tally?.WAITLISTED ?? 0,
      };
    });
  }

  /**
   * Booking counts per session, per status. One `groupBy` rather than the
   * raw version's `COUNT(...) FILTER (WHERE ...)` in the main query: the
   * aggregate cannot be expressed in a Prisma `include`, and doing it as a
   * second round trip keeps the session read typed.
   */
  private async countsBySession(sessionIds: string[]) {
    const grouped = await this.prisma.classBooking.groupBy({
      by: ['sessionId', 'status'],
      where: { sessionId: { in: sessionIds } },
      _count: { _all: true },
    });
    const counts = new Map<string, Partial<Record<string, number>>>();
    for (const row of grouped) {
      const bucket = counts.get(row.sessionId) ?? {};
      bucket[row.status] = row._count._all;
      counts.set(row.sessionId, bucket);
    }
    return counts;
  }

  async createSession(organizationId: string, dto: CreateClassSessionDto) {
    await this.assertBranch(organizationId, dto.branchId);
    await this.assertInstructor(organizationId, dto.instructorId);

    const program = await this.prisma.classProgram.findFirst({
      where: {
        id: dto.classProgramId,
        organizationId,
        branchId: dto.branchId,
        status: 'ACTIVE',
      },
      select: { id: true, instructorId: true },
    });
    if (!program) {
      throw new BadRequestException(
        'Active class program not found for this branch',
      );
    }

    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);
    if (!(startTime < endTime)) {
      throw new BadRequestException('endTime must be after startTime');
    }

    const instructorId = dto.instructorId ?? program.instructorId ?? null;
    await this.assertInstructor(organizationId, instructorId);

    return this.prisma.classSession.create({
      data: {
        organizationId,
        branchId: dto.branchId,
        classProgramId: program.id,
        instructorId,
        startTime,
        endTime,
        capacity: dto.capacity ?? null,
      },
    });
  }

  /**
   * Books a member, or waitlists them when the session is full.
   *
   * The advisory lock is the whole concurrency story: two simultaneous
   * bookings for the last place must not both see `count < capacity`. It is
   * taken on the session id, so it also serialises against `cancel()`,
   * which promotes from the same waitlist.
   */
  async book(organizationId: string, sessionId: string, memberId: string) {
    await this.assertMember(organizationId, memberId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockSession(tx, sessionId);

      const session = await tx.classSession.findFirst({
        where: { id: sessionId, organizationId, status: 'ACTIVE' },
        select: {
          id: true,
          branchId: true,
          capacity: true,
          classProgram: { select: { capacity: true } },
        },
      });
      if (!session) throw new NotFoundException('Class session not found');
      const capacity = session.capacity ?? session.classProgram.capacity;

      const existing = await tx.classBooking.findUnique({
        where: { sessionId_memberId: { sessionId, memberId } },
        select: { id: true, status: true },
      });
      if (
        existing &&
        (LIVE_STATUSES as readonly string[]).includes(existing.status)
      ) {
        throw new BadRequestException('Member is already booked or waitlisted');
      }

      const booked = await tx.classBooking.count({
        where: { sessionId, status: 'BOOKED' },
      });

      // A place is free: book, whether this is a new row or the revival of
      // a cancelled one. Reviving clears the previous outcome -- a member
      // who was marked NO_SHOW and re-books is not still a no-show.
      if (booked < capacity) {
        const data = {
          status: 'BOOKED' as const,
          waitlistPosition: null,
          cancelledAt: null,
          attendanceAt: null,
          bookedAt: new Date(),
        };
        return existing
          ? tx.classBooking.update({ where: { id: existing.id }, data })
          : tx.classBooking.create({
              data: {
                organizationId,
                branchId: session.branchId,
                sessionId,
                memberId,
                ...data,
              },
            });
      }

      const waitlistPosition = await this.nextWaitlistPosition(tx, sessionId);
      const data = {
        status: 'WAITLISTED' as const,
        waitlistPosition,
        cancelledAt: null,
        attendanceAt: null,
        bookedAt: new Date(),
      };
      return existing
        ? tx.classBooking.update({ where: { id: existing.id }, data })
        : tx.classBooking.create({
            data: {
              organizationId,
              branchId: session.branchId,
              sessionId,
              memberId,
              ...data,
            },
          });
    });
  }

  /**
   * Cancels a booking and promotes the head of the waitlist.
   *
   * Takes the same advisory lock `book()` does. The raw version used
   * `SELECT ... FOR UPDATE` on the booking rows instead, which locks
   * different objects than `book()` does and so did not exclude it: a
   * cancellation promoting a waitlisted member while a booking was
   * counting places could put the session one over capacity. Row locks
   * also have no typed Prisma equivalent, so the fix and the port are the
   * same edit.
   */
  /**
   * The roster for one session.
   *
   * Attendance and cancellation are both keyed on a booking id, and until
   * this existed the only place a booking id ever appeared was the response
   * to the POST that created it -- so the front desk had no way to reach
   * either endpoint for a booking someone else had taken.
   *
   * Ordered so the sheet reads the way the desk works it: booked first, in
   * booking order, then the waitlist in queue position, then the settled
   * rows.
   */
  async sessionBookings(organizationId: string, sessionId: string) {
    const session = await this.prisma.classSession.findFirst({
      where: { id: sessionId, organizationId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('Class session not found');

    const bookings = await this.prisma.classBooking.findMany({
      where: { organizationId, sessionId },
      select: {
        id: true,
        memberId: true,
        status: true,
        waitlistPosition: true,
        bookedAt: true,
        cancelledAt: true,
        attendanceAt: true,
        member: {
          select: {
            firstName: true,
            lastName: true,
            memberCode: true,
            phone: true,
          },
        },
      },
      orderBy: [{ waitlistPosition: 'asc' }, { bookedAt: 'asc' }],
    });

    const rank: Record<string, number> = {
      BOOKED: 0,
      WAITLISTED: 1,
      ATTENDED: 2,
      NO_SHOW: 3,
      CANCELLED: 4,
    };
    return bookings
      .map(({ member, ...booking }) => ({
        ...booking,
        memberName: `${member.firstName} ${member.lastName}`.trim(),
        memberCode: member.memberCode,
        memberPhone: member.phone,
      }))
      .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  }

  async cancel(organizationId: string, bookingId: string) {
    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.classBooking.findFirst({
        where: {
          id: bookingId,
          organizationId,
          status: { in: [...LIVE_STATUSES] },
        },
        select: { id: true, status: true, sessionId: true },
      });
      if (!booking) throw new NotFoundException('Active booking not found');

      await this.lockSession(tx, booking.sessionId);

      await tx.classBooking.update({
        where: { id: booking.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          waitlistPosition: null,
        },
      });

      // Only a booked place frees a place. Cancelling from the waitlist
      // promotes nobody.
      if (booking.status === 'BOOKED') {
        const next = await tx.classBooking.findFirst({
          where: {
            organizationId,
            sessionId: booking.sessionId,
            status: 'WAITLISTED',
          },
          orderBy: [{ waitlistPosition: 'asc' }, { createdAt: 'asc' }],
          select: { id: true },
        });
        if (next) {
          await tx.classBooking.update({
            where: { id: next.id },
            data: { status: 'BOOKED', waitlistPosition: null },
          });
        }
      }
      return { ok: true };
    });
  }

  async attendance(
    organizationId: string,
    bookingId: string,
    status: 'ATTENDED' | 'NO_SHOW',
  ) {
    const booking = await this.prisma.classBooking.findFirst({
      where: {
        id: bookingId,
        organizationId,
        status: { in: ['BOOKED', 'ATTENDED', 'NO_SHOW'] },
      },
      select: { id: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return this.prisma.classBooking.update({
      where: { id: booking.id },
      data: { status, attendanceAt: new Date() },
    });
  }

  async analytics(
    organizationId: string,
    from?: string,
    to?: string,
    branchId?: string,
  ) {
    const start = from
      ? new Date(from)
      : new Date(Date.now() - DEFAULT_ANALYTICS_DAYS * DAY_MS);
    const end = to ? new Date(to) : new Date();
    if (!(start < end)) throw new BadRequestException('to must be after from');

    const sessions = await this.prisma.classSession.findMany({
      where: {
        organizationId,
        startTime: { gte: start, lte: end },
        ...(branchId ? { branchId } : {}),
      },
      select: {
        id: true,
        classProgramId: true,
        classProgram: { select: { name: true } },
      },
    });
    if (!sessions.length) return [];

    const counts = await this.countsBySession(sessions.map((s) => s.id));

    // Roll the per-session tallies up to the program. Programs with
    // sessions but no bookings still appear, with zeroes -- the raw
    // version's LEFT JOIN did the same, and "we ran it and nobody came" is
    // the row an operator most needs to see.
    const byProgram = new Map<
      string,
      {
        classProgramId: string;
        className: string;
        totalBookings: number;
        attended: number;
        noShows: number;
        waitlisted: number;
      }
    >();
    for (const session of sessions) {
      const row = byProgram.get(session.classProgramId) ?? {
        classProgramId: session.classProgramId,
        className: session.classProgram.name,
        totalBookings: 0,
        attended: 0,
        noShows: 0,
        waitlisted: 0,
      };
      const tally = counts.get(session.id) ?? {};
      for (const [status, count] of Object.entries(tally)) {
        row.totalBookings += count ?? 0;
        if (status === 'ATTENDED') row.attended += count ?? 0;
        if (status === 'NO_SHOW') row.noShows += count ?? 0;
        if (status === 'WAITLISTED') row.waitlisted += count ?? 0;
      }
      byProgram.set(session.classProgramId, row);
    }
    return [...byProgram.values()].sort(
      (a, b) => b.totalBookings - a.totalBookings,
    );
  }

  /**
   * Serialises everything that reads capacity and writes a place for one
   * session. Raw because there is no Prisma API for an advisory lock; it is
   * a parameterised tagged template, not the `$queryRawUnsafe` this module
   * used to be built from.
   */
  private lockSession(tx: PrismaTx, sessionId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sessionId}))`;
  }

  private async nextWaitlistPosition(tx: PrismaTx, sessionId: string) {
    const highest = await tx.classBooking.aggregate({
      where: { sessionId, status: 'WAITLISTED' },
      _max: { waitlistPosition: true },
    });
    return (highest._max.waitlistPosition ?? 0) + 1;
  }
}
