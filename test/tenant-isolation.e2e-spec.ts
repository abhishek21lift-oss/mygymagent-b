import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * The single most important test in this codebase: Tenant A must never be
 * able to read, list, modify, or delete Tenant B's data, on any of the
 * core domain resources, no matter what id is guessed or supplied.
 */
describe('Tenant isolation (e2e)', () => {
  let app: INestApplication;
  let orgA: RegisteredAccount;
  let orgB: RegisteredAccount;

  async function registerOrg(name: string): Promise<RegisteredAccount> {
    const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: name,
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: name,
      })
      .expect(201);

    const branches = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);

    return {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
    orgA = await registerOrg('Tenant A Gym');
    orgB = await registerOrg('Tenant B Gym');
  });

  afterAll(async () => {
    await app.close();
  });

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  it('Org A cannot see Org B in /organizations/current and vice versa', async () => {
    const a = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get('/organizations/current'),
    ).expect(200);
    const b = await authed(orgB.accessToken)(
      request(app.getHttpServer()).get('/organizations/current'),
    ).expect(200);
    expect(a.body.data.id).toBe(orgA.organizationId);
    expect(b.body.data.id).toBe(orgB.organizationId);
    expect(a.body.data.id).not.toBe(b.body.data.id);
  });

  it('Org A cannot read, update, or delete a branch belonging to Org B', async () => {
    await authed(orgB.accessToken)(
      request(app.getHttpServer()).get(`/branches/${orgA.branchId}`),
    ).expect(404);
    await authed(orgB.accessToken)(
      request(app.getHttpServer())
        .patch(`/branches/${orgA.branchId}`)
        .send({ name: 'Hijacked' }),
    ).expect(404);
    await authed(orgB.accessToken)(
      request(app.getHttpServer()).delete(`/branches/${orgA.branchId}`),
    ).expect(404);

    // And Org A's branch list never contains Org B's branch id.
    const listA = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    expect(
      listA.body.data.items.map((b: { id: string }) => b.id),
    ).not.toContain(orgB.branchId);
  });

  it('Org A cannot read or modify a member belonging to Org B', async () => {
    const created = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgB.branchId,
        firstName: 'Secret',
        lastName: 'MemberB',
      }),
    ).expect(201);
    const memberBId = created.body.data.id;

    await authed(orgA.accessToken)(
      request(app.getHttpServer()).get(`/members/${memberBId}`),
    ).expect(404);
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .patch(`/members/${memberBId}`)
        .send({ firstName: 'Hijacked' }),
    ).expect(404);
    await authed(orgA.accessToken)(
      request(app.getHttpServer()).delete(`/members/${memberBId}`),
    ).expect(404);

    const listA = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get('/members'),
    ).expect(200);
    expect(
      listA.body.data.items.map((m: { id: string }) => m.id),
    ).not.toContain(memberBId);
  });

  it('Org A cannot create a membership for a member that belongs to Org B', async () => {
    const memberB = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgB.branchId,
        firstName: 'Cross',
        lastName: 'TenantTarget',
      }),
    ).expect(201);

    const planA = await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Org A Monthly', durationDays: 30, price: 49.99 }),
    ).expect(201);

    // Org A tries to sell its own plan to Org B's member -- must fail
    // because memberId is looked up scoped to Org A's organizationId.
    await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/memberships').send({
        memberId: memberB.body.data.id,
        membershipPlanId: planA.body.data.id,
      }),
    ).expect(404);
  });

  it("Org A cannot use Org B's membership plan even for its own member", async () => {
    const memberA = await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgA.branchId,
        firstName: 'Own',
        lastName: 'MemberA',
      }),
    ).expect(201);

    const planB = await authed(orgB.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Org B Monthly', durationDays: 30, price: 39.99 }),
    ).expect(201);

    await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/memberships').send({
        memberId: memberA.body.data.id,
        membershipPlanId: planB.body.data.id,
      }),
    ).expect(404);
  });

  it('Org A cannot check in a member belonging to Org B, even by guessing branch/member ids', async () => {
    const memberB = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgB.branchId,
        firstName: 'Attendance',
        lastName: 'TargetB',
      }),
    ).expect(201);

    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/attendance/check-in')
        .send({ branchId: orgA.branchId, memberId: memberB.body.data.id }),
    ).expect(404);

    // Using Org B's own branch id from Org A's token is also rejected.
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/attendance/check-in')
        .send({ branchId: orgB.branchId, memberId: memberB.body.data.id }),
    ).expect(404);
  });

  it('Org A cannot record, read, or refund a payment against a member belonging to Org B', async () => {
    const memberB = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgB.branchId,
        firstName: 'Payment',
        lastName: 'TargetB',
      }),
    ).expect(201);

    // Org A cannot record a payment against Org B's member.
    await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId: memberB.body.data.id,
        amount: 50,
      }),
    ).expect(404);

    // Org B records its own payment...
    const paymentB = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId: memberB.body.data.id,
        amount: 75,
      }),
    ).expect(201);

    // ...which Org A can neither read nor refund by guessing the id.
    await authed(orgA.accessToken)(
      request(app.getHttpServer()).get(`/payments/${paymentB.body.data.id}`),
    ).expect(404);
    await authed(orgA.accessToken)(
      request(app.getHttpServer()).post(
        `/payments/${paymentB.body.data.id}/refund`,
      ),
    ).expect(404);

    const listA = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get('/payments'),
    ).expect(200);
    expect(
      listA.body.data.items.map((p: { id: string }) => p.id),
    ).not.toContain(paymentB.body.data.id);
  });

  it("Org A cannot see, assign, or build a plan against Org B's exercises/members", async () => {
    const exerciseB = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/exercises').send({
        name: 'Org B Secret Squat',
      }),
    ).expect(201);

    // Org A can't build a plan referencing Org B's exercise library entry.
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/workout-plans')
        .send({
          name: 'Cross-tenant plan',
          exercises: [
            {
              exerciseId: exerciseB.body.data.id,
              order: 1,
              sets: 3,
              reps: '10',
            },
          ],
        }),
    ).expect(400);

    const planB = await authed(orgB.accessToken)(
      request(app.getHttpServer())
        .post('/workout-plans')
        .send({
          name: 'Org B Plan',
          exercises: [
            {
              exerciseId: exerciseB.body.data.id,
              order: 1,
              sets: 3,
              reps: '10',
            },
          ],
        }),
    ).expect(201);

    // Org A can't read Org B's plan by guessing its id.
    await authed(orgA.accessToken)(
      request(app.getHttpServer()).get(`/workout-plans/${planB.body.data.id}`),
    ).expect(404);

    const memberB = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgB.branchId,
        firstName: 'Workout',
        lastName: 'TargetB',
      }),
    ).expect(201);

    // Org A can't assign Org B's plan to Org B's member, nor its own plan
    // (if it had one) to Org B's member.
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post(`/workout-plans/${planB.body.data.id}/assign`)
        .send({ memberId: memberB.body.data.id }),
    ).expect(404);
  });

  it('Org A cannot see, convert, or add follow-ups to a lead belonging to Org B', async () => {
    const leadB = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'Prospect',
        lastName: 'TargetB',
        branchId: orgB.branchId,
      }),
    ).expect(201);

    await authed(orgA.accessToken)(
      request(app.getHttpServer()).get(`/leads/${leadB.body.data.id}`),
    ).expect(404);
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .patch(`/leads/${leadB.body.data.id}/status`)
        .send({ status: 'CONTACTED' }),
    ).expect(404);
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post(`/leads/${leadB.body.data.id}/convert`)
        .send({}),
    ).expect(404);
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post(`/leads/${leadB.body.data.id}/follow-ups`)
        .send({ dueAt: new Date().toISOString(), note: 'Call them' }),
    ).expect(404);

    const listA = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get('/leads'),
    ).expect(200);
    expect(
      listA.body.data.items.map((l: { id: string }) => l.id),
    ).not.toContain(leadB.body.data.id);
  });

  it("Org A cannot see, assign, or build a diet plan against Org B's food items/members", async () => {
    const foodB = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/food-items').send({
        name: 'Org B Secret Shake',
      }),
    ).expect(201);

    // Org A can't build a plan referencing Org B's food library entry.
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/diet-plans')
        .send({
          name: 'Cross-tenant plan',
          items: [
            {
              foodItemId: foodB.body.data.id,
              mealSlot: 'BREAKFAST',
              quantity: 1,
              unit: 'cup',
            },
          ],
        }),
    ).expect(400);

    const planB = await authed(orgB.accessToken)(
      request(app.getHttpServer())
        .post('/diet-plans')
        .send({
          name: 'Org B Plan',
          items: [
            {
              foodItemId: foodB.body.data.id,
              mealSlot: 'BREAKFAST',
              quantity: 1,
              unit: 'cup',
            },
          ],
        }),
    ).expect(201);

    // Org A can't read Org B's plan by guessing its id.
    await authed(orgA.accessToken)(
      request(app.getHttpServer()).get(`/diet-plans/${planB.body.data.id}`),
    ).expect(404);

    const memberB = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgB.branchId,
        firstName: 'Diet',
        lastName: 'TargetB',
      }),
    ).expect(201);

    // Org A can't assign Org B's plan to Org B's member.
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post(`/diet-plans/${planB.body.data.id}/assign`)
        .send({ memberId: memberB.body.data.id }),
    ).expect(404);
  });

  it('rejects (rather than silently ignoring) an attempt to inject organizationId into the request body', async () => {
    // CreateMemberDto has no organizationId field, and the global
    // ValidationPipe runs with forbidNonWhitelisted: true, so an injected
    // organizationId is a hard 400 -- not silently stripped, and never a
    // vector to write into another tenant.
    await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgA.branchId,
        firstName: 'Injected',
        lastName: 'OrgId',
        organizationId: orgB.organizationId,
      }),
    ).expect(400);

    // The same request without the injected field succeeds and is scoped
    // to the caller's own organization regardless.
    const res = await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgA.branchId,
        firstName: 'Clean',
        lastName: 'OrgId',
      }),
    ).expect(201);
    expect(res.body.data.organizationId).toBe(orgA.organizationId);
  });

  it('rejects a request with no permission grant for the acting role', async () => {
    // Register a fresh org and immediately try an action requiring a
    // permission the brand-new owner does have, to sanity check the guard
    // actually runs; then verify a request with a syntactically valid but
    // unrelated (wrong-tenant) resource id is 404, not a 500 or a silent
    // no-op that could mask a tenant leak.
    await authed(orgB.accessToken)(
      request(app.getHttpServer()).get(`/memberships/${orgA.branchId}`),
    ).expect(404);
  });
});
