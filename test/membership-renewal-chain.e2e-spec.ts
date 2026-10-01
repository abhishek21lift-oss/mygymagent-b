import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MembershipStatusScanner } from '../src/automation/scanners/membership-status.scanner';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

const DAY = 24 * 60 * 60 * 1000;

/**
 * A running membership renews into a term that starts the day it ends.
 * These are the ways the two drifted apart: the current term grew (a
 * freeze, an extension) and the next one didn't move, so they overlapped
 * and the member lost the days; a double-tap sold two renewals; a plan
 * change ran beside an already-sold renewal.
 */
describe('Membership renewal chain (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gym: RegisteredAccount;
  let planId: string;
  let otherPlanId: string;

  const server = () => app.getHttpServer();
  const owner = () => ({
    post: (url: string) =>
      request(server())
        .post(url)
        .set('Authorization', `Bearer ${gym.accessToken}`),
  });

  /** A member on a running 30-day term, already renewed once. */
  async function renewedMember(firstName: string) {
    const member = await owner()
      .post('/members')
      .send({ primaryBranchId: gym.branchId, firstName, lastName: 'Chain' })
      .expect(201);
    const current = await owner()
      .post('/memberships')
      .send({ memberId: member.body.data.id, membershipPlanId: planId })
      .expect(201);
    const next = await owner()
      .post(`/memberships/${current.body.data.id}/renew`)
      .send({})
      .expect(201);
    return {
      currentId: current.body.data.id as string,
      nextId: next.body.data.id as string,
      currentEnd: new Date(current.body.data.endDate),
    };
  }

  const term = (id: string) =>
    prisma.membership.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Renewal Chain Gym',
        email: `renewal-chain-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    const token = res.body.data.accessToken;
    gym = {
      accessToken: token,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: (
        await request(server())
          .get('/branches')
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body.data.items[0].id,
    };
    planId = (
      await owner()
        .post('/membership-plans')
        .send({
          name: 'Monthly',
          durationDays: 30,
          price: 1000,
          maxFreezeDays: 30,
        })
        .expect(201)
    ).body.data.id;
    otherPlanId = (
      await owner()
        .post('/membership-plans')
        .send({ name: 'Quarterly', durationDays: 90, price: 2700 })
        .expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  it('sells one renewal for a double-tap, not two', async () => {
    const member = await owner()
      .post('/members')
      .send({
        primaryBranchId: gym.branchId,
        firstName: 'Double',
        lastName: 'Tap',
      })
      .expect(201);
    const current = await owner()
      .post('/memberships')
      .send({ memberId: member.body.data.id, membershipPlanId: planId })
      .expect(201);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        owner().post(`/memberships/${current.body.data.id}/renew`).send({}),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400]);
    expect(
      await prisma.membership.count({
        where: { previousMembershipId: current.body.data.id },
      }),
    ).toBe(1);
  });

  it('moves the renewal when the current term is extended', async () => {
    const { currentId, nextId, currentEnd } = await renewedMember('Extend');
    const before = await term(nextId);
    await owner()
      .post(`/memberships/${currentId}/extend`)
      .send({ days: 10 })
      .expect(201);
    const after = await term(nextId);
    expect(after.startDate.getTime()).toBe(currentEnd.getTime() + 10 * DAY);
    expect(after.endDate.getTime()).toBe(before.endDate.getTime() + 10 * DAY);
    // No overlap with the term before it.
    expect(after.startDate.getTime()).toBe(
      (await term(currentId)).endDate.getTime(),
    );
  });

  it('moves the renewal by the days a freeze gives back, resumed by hand', async () => {
    const { currentId, nextId, currentEnd } = await renewedMember('Freeze');
    await owner()
      .post(`/memberships/${currentId}/freeze`)
      .send({ days: 5 })
      .expect(201);
    // Frozen five days ago.
    await prisma.membership.update({
      where: { id: currentId },
      data: {
        // Booked for five days, and the five days are up.
        freezeStartDate: new Date(Date.now() - 5 * DAY),
        freezeEndDate: new Date(Date.now()),
      },
    });
    await owner().post(`/memberships/${currentId}/resume`).expect(201);
    const current = await term(currentId);
    const next = await term(nextId);
    expect(current.endDate.getTime()).toBe(currentEnd.getTime() + 5 * DAY);
    expect(next.startDate.getTime()).toBe(current.endDate.getTime());
  });

  it('moves the renewal when a freeze ends on its own', async () => {
    const { currentId, nextId } = await renewedMember('AutoResume');
    await owner()
      .post(`/memberships/${currentId}/freeze`)
      .send({ days: 4 })
      .expect(201);
    await prisma.membership.update({
      where: { id: currentId },
      data: {
        freezeStartDate: new Date(Date.now() - 5 * DAY),
        freezeEndDate: new Date(Date.now() - DAY),
      },
    });
    await app.get(MembershipStatusScanner).scan();
    const current = await term(currentId);
    const next = await term(nextId);
    expect(current.status).toBe('ACTIVE');
    expect(next.startDate.getTime()).toBe(current.endDate.getTime());
  });

  it("won't freeze a term that hasn't started", async () => {
    const { nextId } = await renewedMember('Future');
    await owner()
      .post(`/memberships/${nextId}/freeze`)
      .send({ days: 3 })
      .expect(400);
  });

  it('refuses a plan change that would run beside a sold renewal', async () => {
    const { currentId, nextId } = await renewedMember('Switcher');
    await owner()
      .post(`/memberships/${currentId}/change-plan`)
      .send({ membershipPlanId: otherPlanId })
      .expect(400);
    await owner()
      .post(`/memberships/${nextId}/change-plan`)
      .send({ membershipPlanId: otherPlanId })
      .expect(400);
  });
});
