import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { PtPackagesService } from '../src/pt-packages/pt-packages.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

const PASSWORD = 'CorrectHorseBattery9';
const HOUR = 60 * 60 * 1000;

/**
 * Module-level holes from the audit: search that ignored a caller's branch,
 * a finished class that still took bookings, a trainer bookable at two
 * branches for the same hour, and a PT pack that two completions at once
 * could overrun.
 */
describe('Modules audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gym: RegisteredAccount;
  let otherBranchId: string;

  const server = () => app.getHttpServer();
  const as = (token: string, branchId?: string) => {
    const withAuth = (req: request.Test) => {
      req.set('Authorization', `Bearer ${token}`);
      if (branchId) req.set('x-branch-id', branchId);
      return req;
    };
    return {
      get: (url: string) => withAuth(request(server()).get(url)),
      post: (url: string) => withAuth(request(server()).post(url)),
      patch: (url: string) => withAuth(request(server()).patch(url)),
    };
  };
  const owner = () => as(gym.accessToken);

  async function member(firstName: string, branchId = gym.branchId) {
    const res = await owner()
      .post('/members')
      .send({ primaryBranchId: branchId, firstName, lastName: 'Audit' })
      .expect(201);
    return res.body.data.id as string;
  }

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Modules Audit Gym',
        email: `modules-audit-${Date.now()}@example.com`,
        password: PASSWORD,
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    const token = res.body.data.accessToken;
    gym = {
      accessToken: token,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: (await as(token).get('/branches').expect(200)).body.data
        .items[0].id,
    };
    otherBranchId = (
      await owner()
        .post('/branches')
        .send({ name: 'Second', slug: `second-${Date.now()}` })
        .expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  it("keeps a branch-scoped searcher to their own branch's members", async () => {
    const tag = `Zq${Date.now().toString(36)}`;
    await member(`${tag}Home`);
    await member(`${tag}Away`, otherBranchId);

    const email = `scoped-admin-${Date.now()}@example.com`;
    const invited = await owner()
      .post('/users')
      .send({
        email,
        firstName: 'Scoped',
        lastName: 'Admin',
        primaryBranchId: gym.branchId,
        roleKey: 'ORG_ADMIN',
        roleBranchId: gym.branchId,
      })
      .expect(201);
    await prisma.user.update({
      where: { id: invited.body.data.id },
      data: { status: 'ACTIVE', passwordHash: await argon2.hash(PASSWORD) },
    });
    const session = await request(server())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);

    const res = await as(session.body.data.accessToken, gym.branchId)
      .get(`/search?q=${tag}`)
      .expect(200);
    const titles = res.body.data.results.map((r: { title: string }) => r.title);
    expect(titles).toContain(`${tag}Home Audit`);
    expect(titles).not.toContain(`${tag}Away Audit`);

    const all = await owner().get(`/search?q=${tag}`).expect(200);
    expect(all.body.data.results).toHaveLength(2);
  });

  it('refuses a booking for a class that has finished', async () => {
    const program = await owner()
      .post('/classes/programs')
      .send({
        branchId: gym.branchId,
        name: 'Finished HIIT',
        capacity: 10,
        durationMinutes: 45,
      })
      .expect(201);
    const session = await owner()
      .post('/classes/sessions')
      .send({
        branchId: gym.branchId,
        classProgramId: program.body.data.id,
        startTime: new Date(Date.now() + 24 * HOUR).toISOString(),
        endTime: new Date(Date.now() + 25 * HOUR).toISOString(),
      })
      .expect(201);
    await prisma.classSession.update({
      where: { id: session.body.data.id },
      data: {
        startTime: new Date(Date.now() - 3 * HOUR),
        endTime: new Date(Date.now() - 2 * HOUR),
      },
    });
    const memberId = await member('Late');
    const res = await owner()
      .post(`/classes/sessions/${session.body.data.id}/book`)
      .send({ memberId })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/already finished/);
  });

  describe('personal training', () => {
    let trainerId: string;

    beforeAll(async () => {
      const coach = await owner()
        .post('/users')
        .send({
          email: `coach-${Date.now()}@example.com`,
          firstName: 'Coach',
          lastName: 'Audit',
          primaryBranchId: gym.branchId,
          roleKey: 'TRAINER',
          isTrainer: true,
        })
        .expect(201);
      trainerId = (
        await prisma.staffProfile.findFirstOrThrow({
          where: { userId: coach.body.data.id },
        })
      ).id;
    });

    it('will not book one trainer at two branches for the same hour', async () => {
      const start = new Date(Date.now() + 48 * HOUR);
      const end = new Date(start.getTime() + HOUR);
      await owner()
        .post('/pt-sessions')
        .send({
          memberId: await member('PtHome'),
          branchId: gym.branchId,
          trainerId,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
        })
        .expect(201);
      await owner()
        .post('/pt-sessions')
        .send({
          memberId: await member('PtAway', otherBranchId),
          branchId: otherBranchId,
          trainerId,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
        })
        .expect(400);
    });

    it('never takes more sessions from a pack than it holds', async () => {
      const memberId = await member('PackRace');
      const pack = await prisma.ptPackage.create({
        data: {
          organizationId: gym.organizationId,
          branchId: gym.branchId,
          memberId,
          name: 'Single session',
          totalSessions: 1,
          startDate: new Date(Date.now() - 24 * HOUR),
          endDate: new Date(Date.now() + 30 * 24 * HOUR),
          price: 1000,
          currency: 'INR',
          status: 'ACTIVE',
        },
      });
      const sessions: string[] = [];
      for (const offset of [72, 74, 76, 78, 80]) {
        const start = new Date(Date.now() + offset * HOUR);
        const created = await owner()
          .post('/pt-sessions')
          .send({
            memberId,
            branchId: gym.branchId,
            startTime: start.toISOString(),
            endTime: new Date(start.getTime() + HOUR).toISOString(),
          })
          .expect(201);
        sessions.push(created.body.data.id);
      }
      // The pack must cover the sessions' dates.
      await prisma.ptPackage.update({
        where: { id: pack.id },
        data: { endDate: new Date(Date.now() + 90 * 24 * HOUR) },
      });

      // Straight at the service, all at once: through HTTP the requests
      // reach the database one after another and the race never shows.
      const packages = app.get(PtPackagesService);
      await Promise.all(
        sessions.map((id) =>
          prisma.$transaction((tx) =>
            packages.consumeForCompletedSession(
              tx,
              gym.organizationId,
              id,
              memberId,
              new Date(Date.now() + 80 * HOUR),
            ),
          ),
        ),
      );

      const after = await prisma.ptPackage.findUniqueOrThrow({
        where: { id: pack.id },
      });
      expect(after.usedSessions).toBe(1);
      expect(after.status).toBe('COMPLETED');
      expect(
        await prisma.ptSessionConsumption.count({
          where: { packageId: pack.id },
        }),
      ).toBe(1);
    });
  });
});
