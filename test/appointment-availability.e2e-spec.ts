import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P0-12: first coverage for the trainer availability surface.
 *
 * `schema.prisma` declared `TrainerAvailabilityRule` and `TrainerTimeOff`,
 * and `appointments.service.ts` queried both in thirteen places -- but no
 * migration ever created either table. Every one of these routes failed at
 * runtime in every deployment, and nothing caught it because the
 * appointments module had no e2e suite at all. That is the shape of the
 * problem the drift was hiding: a model can describe a table that does not
 * exist, and only a request proves otherwise.
 *
 * So this suite is deliberately end-to-end rather than a schema assertion.
 * A test that checks the table exists would pass against a table nothing
 * can use.
 */
describe('Trainer availability and time off (e2e, B-P0-12)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let branchId: string;
  let trainerId: string;
  let trainerToken: string;
  let ruleId: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);

  /** The next occurrence of a given UTC weekday, as YYYY-MM-DD. */
  const nextDay = (dayOfWeek: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((dayOfWeek - d.getUTCDay() + 7) % 7 || 7));
    return d.toISOString().slice(0, 10);
  };
  const WEDNESDAY = 3;

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Availability Test Gym',
        email: `availability-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Availability',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    const invited = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `availability-trainer-${Date.now()}@example.com`,
          firstName: 'Ava',
          lastName: 'Trainer',
          primaryBranchId: branchId,
          roleKey: 'TRAINER',
          isTrainer: true,
        }),
    ).expect(201);
    trainerId = invited.body.data.id;
    await prisma.user.update({
      where: { id: trainerId },
      data: { status: 'ACTIVE' },
    });
    trainerToken = app.get(TokensService).signAccessToken(trainerId);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe('availability rules', () => {
    it('sets a rule and reads it back with the staff member attached', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/appointments/availability').send({
          staffId: trainerId,
          dayOfWeek: WEDNESDAY,
          startMinute: 540,
          endMinute: 1020,
        }),
      ).expect(201);
      ruleId = created.body.data.id;
      expect(created.body.data.isActive).toBe(true);

      const list = await asOwner(
        request(app.getHttpServer())
          .get('/appointments/availability')
          .query({ staffId: trainerId }),
      ).expect(200);
      const rule = list.body.data.find((r: { id: string }) => r.id === ruleId);
      expect(rule.startMinute).toBe(540);
      expect(rule.staff.id).toBe(trainerId);
    });

    it('updates the existing rule rather than stacking a second one', async () => {
      const updated = await asOwner(
        request(app.getHttpServer()).post('/appointments/availability').send({
          staffId: trainerId,
          dayOfWeek: WEDNESDAY,
          startMinute: 600,
          endMinute: 960,
        }),
      ).expect(201);
      expect(updated.body.data.id).toBe(ruleId);

      const rules = await prisma.trainerAvailabilityRule.count({
        where: { staffId: trainerId, dayOfWeek: WEDNESDAY },
      });
      expect(rules).toBe(1);
    });

    it('rejects an end before the start, and a trainer from another org', async () => {
      await asOwner(
        request(app.getHttpServer()).post('/appointments/availability').send({
          staffId: trainerId,
          dayOfWeek: WEDNESDAY,
          startMinute: 900,
          endMinute: 600,
        }),
      ).expect(400);

      await asOwner(
        request(app.getHttpServer()).post('/appointments/availability').send({
          staffId: '00000000-0000-0000-0000-000000000000',
          dayOfWeek: WEDNESDAY,
          startMinute: 540,
          endMinute: 600,
        }),
      ).expect(400);
    });

    it('denies a caller without appointments.manage_availability', async () => {
      await authed(trainerToken)(
        request(app.getHttpServer()).post('/appointments/availability').send({
          staffId: trainerId,
          dayOfWeek: 1,
          startMinute: 540,
          endMinute: 600,
        }),
      ).expect(403);
    });
  });

  describe('time off', () => {
    let timeOffId: string;

    it('records a block and lists it', async () => {
      // `POST /appointments/time-off` answers `{ ok: true }` rather than
      // the created row -- unlike `POST /appointments/availability`, which
      // returns it -- so the id has to come back from the listing.
      await asOwner(
        request(app.getHttpServer())
          .post('/appointments/time-off')
          .send({
            staffId: trainerId,
            startAt: `${nextDay(WEDNESDAY)}T11:00:00.000Z`,
            endAt: `${nextDay(WEDNESDAY)}T12:00:00.000Z`,
            reason: 'Physio',
          }),
      ).expect(201);

      const list = await asOwner(
        request(app.getHttpServer())
          .get('/appointments/time-off')
          .query({ staffId: trainerId }),
      ).expect(200);
      const block = list.body.data.find(
        (t: { reason: string }) => t.reason === 'Physio',
      );
      expect(block).toBeDefined();
      expect(block.staff.id).toBe(trainerId);
      timeOffId = block.id;
    });

    it('rejects an end before the start', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/appointments/time-off')
          .send({
            staffId: trainerId,
            startAt: `${nextDay(WEDNESDAY)}T14:00:00.000Z`,
            endAt: `${nextDay(WEDNESDAY)}T13:00:00.000Z`,
          }),
      ).expect(400);
    });

    it('removes it, and refuses to remove another organization’s', async () => {
      await asOwner(
        request(app.getHttpServer()).delete(
          '/appointments/time-off/00000000-0000-0000-0000-000000000000',
        ),
      ).expect(404);

      await asOwner(
        request(app.getHttpServer()).delete(
          `/appointments/time-off/${timeOffId}`,
        ),
      ).expect(200);
      expect(
        await prisma.trainerTimeOff.count({ where: { id: timeOffId } }),
      ).toBe(0);
    });
  });

  describe('free slots', () => {
    it('derives the window from the rule, and subtracts time off', async () => {
      const day = nextDay(WEDNESDAY);

      const before = await asOwner(
        request(app.getHttpServer())
          .get('/appointments/free-slots')
          .query({ staffId: trainerId, day }),
      ).expect(200);
      // The rule set above is 600 -> 960 minutes, i.e. 10:00 to 16:00 UTC.
      expect(before.body.data.windows.length).toBeGreaterThan(0);
      expect(before.body.data.windows[0].start).toContain(`${day}T10:00`);

      await asOwner(
        request(app.getHttpServer())
          .post('/appointments/time-off')
          .send({
            staffId: trainerId,
            startAt: `${day}T10:00:00.000Z`,
            endAt: `${day}T16:00:00.000Z`,
            reason: 'Away all day',
          }),
      ).expect(201);

      const after = await asOwner(
        request(app.getHttpServer())
          .get('/appointments/free-slots')
          .query({ staffId: trainerId, day }),
      ).expect(200);
      const slots = after.body.data.windows.flatMap(
        (w: { slots?: unknown[] }) => w.slots ?? [],
      );
      expect(slots).toHaveLength(0);
    });

    it('says so plainly when a trainer has no rules, rather than inventing 9-to-5', async () => {
      const other = await asOwner(
        request(app.getHttpServer())
          .post('/users')
          .send({
            email: `availability-none-${Date.now()}@example.com`,
            firstName: 'Nora',
            lastName: 'Norules',
            primaryBranchId: branchId,
            roleKey: 'TRAINER',
            isTrainer: true,
          }),
      ).expect(201);

      const res = await asOwner(
        request(app.getHttpServer())
          .get('/appointments/free-slots')
          .query({ staffId: other.body.data.id, day: nextDay(WEDNESDAY) }),
      ).expect(200);
      expect(res.body.data.windows).toHaveLength(0);
      expect(res.body.data.note).toContain('No availability rules');
    });
  });

  it('deletes an availability rule and stops offering its window', async () => {
    await asOwner(
      request(app.getHttpServer()).delete(
        `/appointments/availability/${ruleId}`,
      ),
    ).expect(200);

    const res = await asOwner(
      request(app.getHttpServer())
        .get('/appointments/free-slots')
        .query({ staffId: trainerId, day: nextDay(WEDNESDAY) }),
    ).expect(200);
    expect(res.body.data.windows).toHaveLength(0);
  });
});
