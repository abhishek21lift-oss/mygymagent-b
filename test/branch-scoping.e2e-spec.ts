import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * A UserRole can be granted org-wide or scoped to a single branch
 * (see PermissionsGuard's class comment). This suite exercises the
 * previously-untested half of that: a manager whose *only* grant is
 * scoped to Branch A must never be able to read, write, or list another
 * branch's data within the same organization -- even though both branches
 * belong to an org they otherwise have real permissions in.
 *
 * The invited manager is activated directly via Prisma and issued a token
 * via TokensService rather than walking the invite-accept email flow --
 * that flow is covered elsewhere; this suite is about authorization, not
 * onboarding UX.
 */
describe('Branch scoping (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokensService;
  let owner: RegisteredAccount;
  let branchA: string;
  let branchB: string;
  let managerToken: string;

  const authed = (token: string, branchId?: string) => (req: request.Test) => {
    req.set('Authorization', `Bearer ${token}`);
    if (branchId) req.set('x-branch-id', branchId);
    return req;
  };
  const asManager = (req: request.Test) => authed(managerToken, branchA)(req);
  const asOwner = (req: request.Test) => authed(owner.accessToken)(req);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    tokens = app.get(TokensService);

    const email = `branch-scope-owner-${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Branch Scoping Test Gym',
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Test',
      })
      .expect(201);
    owner = {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: '',
    };

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchA = branches.body.data.items[0].id;

    const branchBRes = await asOwner(
      request(app.getHttpServer())
        .post('/branches')
        .send({ name: 'Branch B', slug: 'branch-b' }),
    ).expect(201);
    branchB = branchBRes.body.data.id;

    const managerEmail = `branch-manager-${Date.now()}@example.com`;
    const invited = await asOwner(
      request(app.getHttpServer()).post('/users').send({
        email: managerEmail,
        firstName: 'Branch',
        lastName: 'Manager',
        primaryBranchId: branchA,
        roleKey: 'BRANCH_MANAGER',
        roleBranchId: branchA,
      }),
    ).expect(201);
    const managerId = invited.body.data.id;

    await prisma.user.update({
      where: { id: managerId },
      data: { status: 'ACTIVE' },
    });
    managerToken = tokens.signAccessToken(managerId);
  });

  afterAll(async () => {
    await app.close();
  });

  it('is rejected outright (403) if the branch-scoped manager omits the x-branch-id header', async () => {
    await authed(managerToken)(
      request(app.getHttpServer()).get('/members'),
    ).expect(403);
  });

  it('lets a branch-scoped manager create, read, and update a member in their own branch', async () => {
    const created = await asManager(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchA,
        firstName: 'Own',
        lastName: 'Branch',
      }),
    ).expect(201);

    await asManager(
      request(app.getHttpServer()).get(`/members/${created.body.data.id}`),
    ).expect(200);

    await asManager(
      request(app.getHttpServer())
        .patch(`/members/${created.body.data.id}`)
        .send({ notes: 'updated by branch manager' }),
    ).expect(200);
  });

  it('blocks a branch-scoped manager from creating a member in another branch', async () => {
    await asManager(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchB,
        firstName: 'Wrong',
        lastName: 'Branch',
      }),
    ).expect(400);
  });

  it("blocks a branch-scoped manager from reading, updating, or deleting another branch's member", async () => {
    const memberB = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchB,
        firstName: 'Other',
        lastName: 'BranchMember',
      }),
    ).expect(201);

    await asManager(
      request(app.getHttpServer()).get(`/members/${memberB.body.data.id}`),
    ).expect(404);

    await asManager(
      request(app.getHttpServer())
        .patch(`/members/${memberB.body.data.id}`)
        .send({ notes: 'hijacked' }),
    ).expect(404);
  });

  it("never returns another branch's members in the list endpoint, even with no explicit branchId filter", async () => {
    const list = await asManager(
      request(app.getHttpServer()).get('/members'),
    ).expect(200);
    for (const member of list.body.data.items) {
      expect(member.primaryBranch?.id ?? member.primaryBranchId).toBe(branchA);
    }
  });

  it('blocks a branch-scoped manager from moving a member into another branch via update', async () => {
    const created = await asManager(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchA,
        firstName: 'Stay',
        lastName: 'Put',
      }),
    ).expect(201);

    await asManager(
      request(app.getHttpServer())
        .patch(`/members/${created.body.data.id}`)
        .send({ primaryBranchId: branchB }),
    ).expect(400);
  });

  it('blocks a branch-scoped manager from recording a payment for a member in another branch', async () => {
    const memberB = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchB,
        firstName: 'Pay',
        lastName: 'TargetB',
      }),
    ).expect(201);

    await asManager(
      request(app.getHttpServer()).post('/payments').send({
        memberId: memberB.body.data.id,
        amount: 50,
        method: 'CASH',
      }),
    ).expect(400);
  });

  it('blocks a branch-scoped manager from checking a member into another branch', async () => {
    const memberA = await asManager(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchA,
        firstName: 'CheckIn',
        lastName: 'TargetA',
      }),
    ).expect(201);

    await asManager(
      request(app.getHttpServer()).post('/attendance/check-in').send({
        branchId: branchB,
        memberId: memberA.body.data.id,
        method: 'MANUAL',
      }),
    ).expect(400);
  });

  it("scopes leads the same way: create is blocked cross-branch, and the list excludes other branches'", async () => {
    await asManager(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'Cross',
        lastName: 'BranchLead',
        branchId: branchB,
      }),
    ).expect(400);

    const ownLead = await asManager(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'Own',
        lastName: 'BranchLead',
      }),
    ).expect(201);
    // Omitted branchId defaults to the caller's branch scope.
    expect(ownLead.body.data.branchId).toBe(branchA);

    const leadB = await asOwner(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'Other',
        lastName: 'BranchLead',
        branchId: branchB,
      }),
    ).expect(201);

    await asManager(
      request(app.getHttpServer()).get(`/leads/${leadB.body.data.id}`),
    ).expect(404);

    const list = await asManager(
      request(app.getHttpServer()).get('/leads'),
    ).expect(200);
    expect(
      list.body.data.items.some(
        (l: { id: string }) => l.id === leadB.body.data.id,
      ),
    ).toBe(false);
  });

  it('still lets the org owner (an org-wide grant) act across both branches unrestricted', async () => {
    const memberB = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchB,
        firstName: 'Owner',
        lastName: 'CanSeeMe',
      }),
    ).expect(201);
    await asOwner(
      request(app.getHttpServer()).get(`/members/${memberB.body.data.id}`),
    ).expect(200);
  });
});
