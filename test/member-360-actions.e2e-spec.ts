import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * The server side of Member 360's actions: who may give a member a coach
 * and from which list, and the branch walls around PT packages, PT
 * session history and membership transfers.
 */
describe('Member 360 actions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokensService;
  let organizationId: string;
  let ownerToken: string;
  let branchA: string;
  let branchB: string;
  let managerToken: string;
  let headTrainerToken: string;
  let trainerId: string;
  let receptionistId: string;
  let memberA: string;
  let memberA2: string;
  let memberB: string;
  let planId: string;

  const server = () => app.getHttpServer();
  const as =
    (token: string, branchId?: string) =>
    (req: request.Test): request.Test => {
      req.set('Authorization', `Bearer ${token}`);
      if (branchId) req.set('x-branch-id', branchId);
      return req;
    };
  const owner = (req: request.Test) => as(ownerToken)(req);
  const manager = (req: request.Test) => as(managerToken, branchA)(req);

  async function staff(roleKey: string, roleBranchId?: string) {
    const res = await owner(
      request(server())
        .post('/users')
        .send({
          email: `${roleKey.toLowerCase()}-${Date.now()}-${Math.random()}@example.com`,
          firstName: roleKey,
          lastName: 'Staff',
          primaryBranchId: branchA,
          roleKey,
          ...(roleBranchId ? { roleBranchId } : {}),
        }),
    ).expect(201);
    const id = res.body.data.id as string;
    await prisma.user.update({ where: { id }, data: { status: 'ACTIVE' } });
    return { id, token: tokens.signAccessToken(id) };
  }

  async function member(branchId: string, firstName: string) {
    const res = await owner(
      request(server())
        .post('/members')
        .send({ primaryBranchId: branchId, firstName, lastName: 'Actions' }),
    ).expect(201);
    return res.body.data.id as string;
  }

  async function sell(memberId: string) {
    const res = await owner(
      request(server())
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId }),
    ).expect(201);
    return res.body.data.id as string;
  }

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    tokens = app.get(TokensService);
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Member Actions Gym',
        email: `member-actions-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    ownerToken = res.body.data.accessToken;
    organizationId = res.body.data.organization.id;
    branchA = (await owner(request(server()).get('/branches')).expect(200)).body
      .data.items[0].id;
    branchB = (
      await owner(
        request(server())
          .post('/branches')
          .send({ name: 'Second', slug: `second-${Date.now()}` }),
      ).expect(201)
    ).body.data.id;

    managerToken = (await staff('BRANCH_MANAGER', branchA)).token;
    headTrainerToken = (await staff('HEAD_TRAINER')).token;
    trainerId = (await staff('TRAINER', branchA)).id;
    receptionistId = (await staff('RECEPTIONIST', branchA)).id;

    memberA = await member(branchA, 'Asha');
    memberA2 = await member(branchA, 'Arjun');
    memberB = await member(branchB, 'Bela');
    planId = (
      await owner(
        request(server())
          .post('/membership-plans')
          .send({ name: 'Monthly', durationDays: 30, price: 1000 }),
      ).expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  describe('coach assignment', () => {
    it('lists only the trainers a member at the branch can be given', async () => {
      const res = await owner(
        request(server())
          .get('/members/assignable-trainers')
          .query({ branchId: branchA }),
      ).expect(200);
      const ids = res.body.data.map((t: { id: string }) => t.id);
      expect(ids).toContain(trainerId);
      expect(ids).not.toContain(receptionistId);
      expect(Object.keys(res.body.data[0]).sort()).toEqual(
        ['firstName', 'id', 'lastName'].sort(),
      );
    });

    it("won't list another branch's trainers for a branch-scoped caller", async () => {
      await manager(
        request(server())
          .get('/members/assignable-trainers')
          .query({ branchId: branchB }),
      ).expect(400);
    });

    it('lets a head trainer assign and clear a coach, with history', async () => {
      await as(headTrainerToken)(
        request(server())
          .patch(`/members/${memberA}/trainer`)
          .send({ trainerId }),
      ).expect(200);
      expect(
        (await prisma.member.findUniqueOrThrow({ where: { id: memberA } }))
          .assignedTrainerId,
      ).toBe(trainerId);
      await as(headTrainerToken)(
        request(server())
          .patch(`/members/${memberA}/trainer`)
          .send({ trainerId: null }),
      ).expect(200);
      expect(
        (await prisma.member.findUniqueOrThrow({ where: { id: memberA } }))
          .assignedTrainerId,
      ).toBeNull();
      expect(
        await prisma.memberTrainerHistory.count({
          where: { organizationId, memberId: memberA },
        }),
      ).toBe(2);
    });

    it('refuses someone who is not a trainer', async () => {
      await owner(
        request(server())
          .patch(`/members/${memberA}/trainer`)
          .send({ trainerId: receptionistId }),
      ).expect(400);
    });
  });

  describe('PT packages', () => {
    const pack = (memberId: string, branchId: string) => ({
      memberId,
      branchId,
      name: '10 sessions',
      totalSessions: 10,
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      price: 5000,
    });

    it("keeps a branch-scoped caller to their own branch's packages", async () => {
      await owner(
        request(server()).post('/pt-packages').send(pack(memberB, branchB)),
      ).expect(201);
      await manager(
        request(server()).post('/pt-packages').send(pack(memberA, branchA)),
      ).expect(201);

      const own = await manager(request(server()).get('/pt-packages')).expect(
        200,
      );
      expect(
        own.body.data.map((p: { memberId: string }) => p.memberId),
      ).toEqual([memberA]);
      const all = await owner(request(server()).get('/pt-packages')).expect(
        200,
      );
      expect(all.body.data).toHaveLength(2);
    });

    it('will not sell into another branch, or to its members', async () => {
      await manager(
        request(server()).post('/pt-packages').send(pack(memberB, branchB)),
      ).expect(400);
      await manager(
        request(server()).post('/pt-packages').send(pack(memberB, branchA)),
      ).expect(400);
    });
  });

  it("hides another branch's PT session history", async () => {
    const start = new Date();
    await prisma.ptSession.create({
      data: {
        organizationId,
        memberId: memberB,
        branchId: branchB,
        startTime: start,
        endTime: new Date(start.getTime() + 3_600_000),
      },
    });
    const scoped = await manager(
      request(server()).get('/pt-sessions').query({ memberId: memberB }),
    ).expect(200);
    expect(scoped.body.data.items).toHaveLength(0);
    const all = await owner(
      request(server()).get('/pt-sessions').query({ memberId: memberB }),
    ).expect(200);
    expect(all.body.data.items).toHaveLength(1);
  });

  describe('membership transfer', () => {
    it("won't move a term to another branch's member", async () => {
      const id = await sell(memberA);
      await manager(
        request(server())
          .post(`/memberships/${id}/transfer`)
          .send({ memberId: memberB }),
      ).expect(404);
      await manager(
        request(server())
          .post(`/memberships/${id}/transfer`)
          .send({ memberId: memberA2 }),
      ).expect(201);
    });

    it('refuses a closed term', async () => {
      const id = await sell(memberA);
      await owner(
        request(server()).post(`/memberships/${id}/cancel`).send({}),
      ).expect(201);
      await owner(
        request(server())
          .post(`/memberships/${id}/transfer`)
          .send({ memberId: memberA2 }),
      ).expect(400);
    });

    it('refuses a term whose renewal is already sold', async () => {
      const id = await sell(memberA);
      await owner(
        request(server()).post(`/memberships/${id}/renew`).send({}),
      ).expect(201);
      await owner(
        request(server())
          .post(`/memberships/${id}/transfer`)
          .send({ memberId: memberA2 }),
      ).expect(400);
    });
  });
});
