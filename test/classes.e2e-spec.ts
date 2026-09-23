import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P0-2 (BACKLOG.md): first e2e coverage for src/classes/ (group training).
 *
 * The module's capacity/waitlist logic is the part worth pinning down: a
 * booking past capacity becomes WAITLISTED, and cancelling a BOOKED seat
 * must auto-promote the first waitlisted member (both under a
 * pg_advisory_xact_lock, so a concurrent double-book can't oversell). None
 * of that had a test before this file.
 *
 * Note for whoever picks up B-P0-1's follow-up: like business-os before it,
 * this module talks to class_programs/class_sessions/class_bookings through
 * $queryRawUnsafe with no Prisma model behind them. Unlike business-os, its
 * SQL quotes camelCase columns correctly, so it does work -- the gap here is
 * type safety and schema-drift visibility, not a live bug.
 */
describe('Group training / classes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let branchId: string;
  let otherBranchId: string;
  let memberA: string;
  let memberB: string;
  let limitedToken: string;
  let programId: string;
  let sessionId: string;
  let bookingA: string;
  let bookingB: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);
  const asLimited = (req: request.Test) => authed(limitedToken)(req);

  const iso = (offsetMs: number) =>
    new Date(Date.now() + offsetMs).toISOString();

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Group Training Test Gym',
        email: `classes-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Classes',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    const other = await asOwner(
      request(app.getHttpServer())
        .post('/branches')
        .send({ name: 'Second Branch', slug: `second-${Date.now()}` }),
    ).expect(201);
    otherBranchId = other.body.data.id;

    const a = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Ana',
        lastName: 'Attendee',
      }),
    ).expect(201);
    memberA = a.body.data.id;

    const b = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Ben',
        lastName: 'Waitlist',
      }),
    ).expect(201);
    memberB = b.body.data.id;

    // ACCOUNTANT holds none of classes.* -- TRAINER does (read/manage/book/
    // attendance), so it is not a valid negative fixture here.
    const invited = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `classes-accountant-${Date.now()}@example.com`,
          firstName: 'Limited',
          lastName: 'Accountant',
          primaryBranchId: branchId,
          roleKey: 'ACCOUNTANT',
          roleBranchId: branchId,
        }),
    ).expect(201);
    await prisma.user.update({
      where: { id: invited.body.data.id },
      data: { status: 'ACTIVE' },
    });
    limitedToken = app.get(TokensService).signAccessToken(invited.body.data.id);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe('programs', () => {
    it('creates and lists a program with its branch name', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/classes/programs').send({
          branchId,
          name: 'Morning HIIT',
          description: '45 minutes, all levels',
          capacity: 1,
          durationMinutes: 45,
        }),
      ).expect(201);
      programId = created.body.data.id;
      expect(created.body.data.status).toBe('ACTIVE');

      const list = await asOwner(
        request(app.getHttpServer()).get('/classes/programs'),
      ).expect(200);
      const found = list.body.data.find(
        (p: { id: string }) => p.id === programId,
      );
      expect(found).toBeDefined();
      expect(found.branchName).toBeTruthy();
    });

    it('rejects a program for a branch outside the organization', async () => {
      await asOwner(
        request(app.getHttpServer()).post('/classes/programs').send({
          branchId: '00000000-0000-4000-8000-000000000000',
          name: 'Nowhere class',
          capacity: 10,
          durationMinutes: 30,
        }),
      ).expect(400);
    });

    it('denies a caller without classes.manage', async () => {
      await asLimited(
        request(app.getHttpServer()).post('/classes/programs').send({
          branchId,
          name: 'Should not exist',
          capacity: 5,
          durationMinutes: 30,
        }),
      ).expect(403);
    });
  });

  describe('sessions', () => {
    it('schedules a session against an active program', async () => {
      const created = await asOwner(
        request(app.getHttpServer())
          .post('/classes/sessions')
          .send({
            branchId,
            classProgramId: programId,
            startTime: iso(86400000),
            endTime: iso(86400000 + 45 * 60000),
          }),
      ).expect(201);
      sessionId = created.body.data.id;
      expect(created.body.data.status).toBe('ACTIVE');
    });

    it('rejects an end time before the start time', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/classes/sessions')
          .send({
            branchId,
            classProgramId: programId,
            startTime: iso(2 * 86400000),
            endTime: iso(86400000),
          }),
      ).expect(400);
    });

    it('rejects a session whose program belongs to a different branch', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/classes/sessions')
          .send({
            branchId: otherBranchId,
            classProgramId: programId,
            startTime: iso(86400000),
            endTime: iso(86400000 + 45 * 60000),
          }),
      ).expect(400);
    });

    it('rejects a listing window whose end precedes its start', async () => {
      await asOwner(
        request(app.getHttpServer())
          .get('/classes/sessions')
          .query({ from: iso(2 * 86400000), to: iso(86400000) }),
      ).expect(400);
    });

    it('lists sessions with effective capacity and live booking counts', async () => {
      const list = await asOwner(
        request(app.getHttpServer())
          .get('/classes/sessions')
          .query({ from: iso(-3600000), to: iso(7 * 86400000) }),
      ).expect(200);
      const found = list.body.data.find(
        (s: { id: string }) => s.id === sessionId,
      );
      expect(found).toBeDefined();
      expect(found.effectiveCapacity).toBe(1);
      expect(found.bookedCount).toBe(0);
      expect(found.waitlistCount).toBe(0);
      expect(found.className).toBe('Morning HIIT');
    });
  });

  describe('booking, waitlist and promotion', () => {
    it('books the first member into the only seat', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .post(`/classes/sessions/${sessionId}/book`)
          .send({ memberId: memberA }),
      ).expect(201);
      expect(res.body.data.status).toBe('BOOKED');
      bookingA = res.body.data.id;
    });

    it('waitlists the next member once capacity is reached', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .post(`/classes/sessions/${sessionId}/book`)
          .send({ memberId: memberB }),
      ).expect(201);
      expect(res.body.data.status).toBe('WAITLISTED');
      expect(res.body.data.waitlistPosition).toBe(1);
      bookingB = res.body.data.id;
    });

    it('rejects double-booking the same member', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post(`/classes/sessions/${sessionId}/book`)
          .send({ memberId: memberA }),
      ).expect(400);
    });

    it('rejects booking a member from another organization', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post(`/classes/sessions/${sessionId}/book`)
          .send({ memberId: '00000000-0000-4000-8000-000000000000' }),
      ).expect(400);
    });

    it('reflects both bookings in the session counts', async () => {
      const list = await asOwner(
        request(app.getHttpServer())
          .get('/classes/sessions')
          .query({ from: iso(-3600000), to: iso(7 * 86400000) }),
      ).expect(200);
      const found = list.body.data.find(
        (s: { id: string }) => s.id === sessionId,
      );
      expect(found.bookedCount).toBe(1);
      expect(found.waitlistCount).toBe(1);
    });

    it('promotes the first waitlisted member when a booked seat is cancelled', async () => {
      await asOwner(
        request(app.getHttpServer()).patch(
          `/classes/bookings/${bookingA}/cancel`,
        ),
      ).expect(200);

      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; status: string; waitlistPosition: number | null }>
      >(
        'SELECT id, status, "waitlistPosition" FROM class_bookings WHERE id = ANY($1::text[])',
        [bookingA, bookingB],
      );
      const a = rows.find((r) => r.id === bookingA);
      const b = rows.find((r) => r.id === bookingB);
      expect(a?.status).toBe('CANCELLED');
      expect(b?.status).toBe('BOOKED');
      expect(b?.waitlistPosition).toBeNull();
    });

    it('rejects cancelling an already-cancelled booking', async () => {
      await asOwner(
        request(app.getHttpServer()).patch(
          `/classes/bookings/${bookingA}/cancel`,
        ),
      ).expect(404);
    });

    it('records attendance on the promoted booking', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .patch(`/classes/bookings/${bookingB}/attendance`)
          .send({ status: 'ATTENDED' }),
      ).expect(200);
      expect(res.body.data.status).toBe('ATTENDED');
      expect(res.body.data.attendanceAt).toBeTruthy();
    });

    it('rejects an unknown attendance status', async () => {
      await asLimited(
        request(app.getHttpServer())
          .patch(`/classes/bookings/${bookingB}/attendance`)
          .send({ status: 'MAYBE' }),
      ).expect(403);

      await asOwner(
        request(app.getHttpServer())
          .patch(`/classes/bookings/${bookingB}/attendance`)
          .send({ status: 'MAYBE' }),
      ).expect(400);
    });
  });

  /**
   * B-P0-8. The port to typed Prisma changed one behaviour deliberately:
   * `cancel()` now takes the same session advisory lock `book()` does. The
   * raw version used `SELECT ... FOR UPDATE` on booking rows, which locks
   * different objects than `book()` and therefore did not exclude it --
   * a cancellation promoting from the waitlist while a booking was
   * counting places could put a session over capacity.
   *
   * These cases drive the races concurrently, so they can pass by luck on
   * a single run. They earn their place because they fail when the lock is
   * removed: over five such runs the six-way booking case reddened every
   * time, the cancel-versus-book case on one of them. A race that only
   * sometimes reproduces is still a race.
   */
  describe('capacity holds under concurrency', () => {
    let raceProgramId: string;
    let raceSessionId: string;
    let racers: string[];

    const seatCount = async (sessionId: string, status: string) =>
      prisma.classBooking.count({
        where: { sessionId, status: status as never },
      });

    beforeAll(async () => {
      const program = await asOwner(
        request(app.getHttpServer()).post('/classes/programs').send({
          branchId,
          name: 'Race Condition Yoga',
          capacity: 1,
          durationMinutes: 45,
        }),
      ).expect(201);
      raceProgramId = program.body.data.id;

      const session = await asOwner(
        request(app.getHttpServer())
          .post('/classes/sessions')
          .send({
            branchId,
            classProgramId: raceProgramId,
            startTime: iso(3 * 86400000),
            endTime: iso(3 * 86400000 + 45 * 60000),
          }),
      ).expect(201);
      raceSessionId = session.body.data.id;

      racers = [];
      for (let i = 0; i < 6; i += 1) {
        const member = await asOwner(
          request(app.getHttpServer())
            .post('/members')
            .send({
              primaryBranchId: branchId,
              firstName: `Racer${i}`,
              lastName: 'Concurrent',
            }),
        ).expect(201);
        racers.push(member.body.data.id);
      }
    });

    it('admits exactly one of six simultaneous bookings for one place', async () => {
      await Promise.all(
        racers.map((memberId) =>
          asOwner(
            request(app.getHttpServer())
              .post(`/classes/sessions/${raceSessionId}/book`)
              .send({ memberId }),
          ),
        ),
      );

      expect(await seatCount(raceSessionId, 'BOOKED')).toBe(1);
      expect(await seatCount(raceSessionId, 'WAITLISTED')).toBe(5);

      // The waitlist is a queue, not a bag: five distinct positions.
      const waitlisted = await prisma.classBooking.findMany({
        where: { sessionId: raceSessionId, status: 'WAITLISTED' },
        select: { waitlistPosition: true },
      });
      const positions = waitlisted.map((b) => b.waitlistPosition);
      expect(new Set(positions).size).toBe(positions.length);
    });

    it('does not overbook when a cancellation and a booking race', async () => {
      // The case the old row locks did not cover: cancel() promotes the
      // head of the waitlist at the same moment book() reads the count.
      const booked = await prisma.classBooking.findFirstOrThrow({
        where: { sessionId: raceSessionId, status: 'BOOKED' },
        select: { id: true },
      });
      const outsider = await asOwner(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: branchId,
          firstName: 'Late',
          lastName: 'Arrival',
        }),
      ).expect(201);

      await Promise.all([
        asOwner(
          request(app.getHttpServer()).patch(
            `/classes/bookings/${booked.id}/cancel`,
          ),
        ),
        asOwner(
          request(app.getHttpServer())
            .post(`/classes/sessions/${raceSessionId}/book`)
            .send({ memberId: outsider.body.data.id }),
        ),
      ]);

      // One place, so one booked member -- whether that is the promoted
      // waitlister or the late arrival depends on which transaction won
      // the lock, and either is correct. Two would not be.
      expect(await seatCount(raceSessionId, 'BOOKED')).toBe(1);
    });
  });

  describe('analytics', () => {
    it('aggregates bookings, attendance and no-shows per program', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .get('/classes/analytics')
          .query({ from: iso(-86400000), to: iso(7 * 86400000) }),
      ).expect(200);
      const row = res.body.data.find(
        (r: { classProgramId: string }) => r.classProgramId === programId,
      );
      expect(row).toBeDefined();
      // One cancelled + one attended booking against this program's session.
      expect(row.totalBookings).toBe(2);
      expect(row.attended).toBe(1);
      expect(row.noShows).toBe(0);
      expect(row.waitlisted).toBe(0);
    });

    it('denies a caller without classes.read', async () => {
      await asLimited(
        request(app.getHttpServer()).get('/classes/analytics'),
      ).expect(403);
    });
  });
});
