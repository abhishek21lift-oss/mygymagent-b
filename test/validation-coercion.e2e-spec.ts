import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P0-7 (BACKLOG.md): no silent type coercion at the API boundary.
 *
 * `main.ts` used to set `transformOptions: { enableImplicitConversion:
 * true }`, whose boolean conversion is `Boolean(value)`. Every non-empty
 * string became `true` -- including the strings `"false"` and `"0"` -- so
 * `@IsBoolean()` never saw a value it could reject and a client asking for
 * one thing silently got the opposite. `@Type(() => Boolean)` applies the
 * same `Boolean(value)` and had the same effect on the fields carrying it.
 *
 * The option is gone and the remaining `@Type(() => Boolean)` uses are
 * replaced by `@ToBoolean()`. This suite is what keeps it that way, and it
 * asserts the property from both ends -- that wrong input is *rejected*,
 * and that `false` actually means false where it is observable.
 *
 * Restoring the option, or reintroducing `@Type(() => Boolean)` on any
 * field below, turns these red.
 */
describe('Request validation does not coerce types (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let organizationId: string;
  let branchId: string;

  const authed = (req: request.Test) =>
    req.set('Authorization', `Bearer ${ownerToken}`);

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Coercion Test Gym',
        email: `coercion-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Cora',
        lastName: 'Owner',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;
    organizationId = registered.body.data.organization.id;

    const branches = await authed(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe('a boolean in a JSON body', () => {
    const createUser = (isTrainer: unknown) =>
      authed(
        request(app.getHttpServer())
          .post('/users')
          .send({
            email: `coercion-user-${Date.now()}-${Math.random()}@example.com`,
            firstName: 'Bool',
            lastName: 'Test',
            primaryBranchId: branchId,
            roleKey: 'TRAINER',
            isTrainer,
          }),
      );

    it.each([['false'], ['0'], ['nope'], [0], [1]])(
      'rejects %p instead of coercing it',
      async (value) => {
        // `isTrainer` decides whether this account can be assigned members.
        // Under the old pipe every one of these arrived as `true`.
        await createUser(value).expect(400);
      },
    );

    it('accepts a real boolean', async () => {
      await createUser(true).expect(201);
      await createUser(false).expect(201);
    });

    it('still rejects a string where a notification preference expects a boolean', async () => {
      for (const value of ['false', '0', 'nope']) {
        await authed(
          request(app.getHttpServer())
            .patch('/notifications/preferences/members')
            .send({ inApp: value }),
        ).expect(400);
      }
    });
  });

  describe('a boolean in a query string', () => {
    let activeSupplierId: string;
    let inactiveSupplierId: string;

    beforeAll(async () => {
      const active = await authed(
        request(app.getHttpServer())
          .post('/inventory/suppliers')
          .send({ name: `Active Supplier ${Date.now()}` }),
      ).expect(201);
      activeSupplierId = active.body.data.id;

      const inactive = await authed(
        request(app.getHttpServer())
          .post('/inventory/suppliers')
          .send({ name: `Inactive Supplier ${Date.now()}` }),
      ).expect(201);
      inactiveSupplierId = inactive.body.data.id;
      await prisma.inventorySupplier.update({
        where: { id: inactiveSupplierId },
        data: { isActive: false },
      });
    });

    const suppliers = (activeOnly?: string) =>
      authed(
        request(app.getHttpServer())
          .get('/inventory/suppliers')
          .query(activeOnly === undefined ? {} : { activeOnly }),
      );

    it('treats ?activeOnly=false as false, showing inactive rows', async () => {
      // The observable half of the bug: `"false"` became `true`, so a
      // caller explicitly asking to see everything was silently filtered
      // down to active rows and never knew the others existed.
      const res = await suppliers('false').expect(200);
      const ids = res.body.data.map((row: { id: string }) => row.id);
      expect(ids).toContain(inactiveSupplierId);
      expect(ids).toContain(activeSupplierId);
    });

    it('treats ?activeOnly=true as true, hiding inactive rows', async () => {
      const res = await suppliers('true').expect(200);
      const ids = res.body.data.map((row: { id: string }) => row.id);
      expect(ids).toContain(activeSupplierId);
      expect(ids).not.toContain(inactiveSupplierId);
    });

    it('rejects a value that is neither true nor false', async () => {
      // Guessing at intent is what caused this whole class of bug, so an
      // unrecognised value is a 400 rather than a silent `false`.
      for (const value of ['1', '0', 'yes', 'nope']) {
        await suppliers(value).expect(400);
      }
    });
  });

  describe('a number in a query string', () => {
    it('still converts, because the DTO asks for it explicitly', async () => {
      // Dropping implicit conversion means `@Type(() => Number)` has to be
      // present; without it these would 400 on a perfectly valid request.
      const res = await authed(
        request(app.getHttpServer()).get('/members').query({ pageSize: 1 }),
      ).expect(200);
      expect(res.body.data.pageSize).toBe(1);
      expect(typeof res.body.data.pageSize).toBe('number');
    });

    it('converts on a route with its own limit param', async () => {
      const member = await authed(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: branchId,
          firstName: 'Hist',
          lastName: 'Ory',
        }),
      ).expect(201);
      const exercise = await authed(
        request(app.getHttpServer())
          .post('/exercises')
          .send({ name: `Squat ${Date.now()}`, muscleGroup: 'LEGS' }),
      ).expect(201);

      await authed(
        request(app.getHttpServer()).get('/workouts/exercise-history').query({
          memberId: member.body.data.id,
          exerciseId: exercise.body.data.id,
          limit: 5,
        }),
      ).expect(200);
    });

    it('still rejects a non-numeric value', async () => {
      await authed(
        request(app.getHttpServer())
          .get('/members')
          .query({ pageSize: 'lots' }),
      ).expect(400);
    });
  });

  it('keeps the organization scoped throughout', async () => {
    // Guards against the fixtures above leaking into another tenant's data
    // and making the assertions accidentally true.
    const count = await prisma.inventorySupplier.count({
      where: { organizationId },
    });
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
