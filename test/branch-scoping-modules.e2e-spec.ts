import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * The modules the security audit found taking no branch scope at all:
 * segments, member intelligence, lead score, audit log, classes, entry
 * QR codes, kiosk devices, loyalty and accounting. `branch-scoping.e2e`
 * covers members, payments, leads and staff; this covers the rest. The
 * manager here holds BRANCH_MANAGER for Branch A only.
 */
describe('Branch scoping across modules (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let branchA: string;
  let branchB: string;
  let managerToken: string;
  let memberA: string;
  let memberB: string;

  const authed = (token: string, branchId?: string) => (req: request.Test) => {
    req.set('Authorization', `Bearer ${token}`);
    if (branchId) req.set('x-branch-id', branchId);
    return req;
  };
  const asManager = (req: request.Test) => authed(managerToken, branchA)(req);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const res = await http()
      .post('/auth/register')
      .send({
        organizationName: 'Module Branch Scoping Gym',
        email: `module-scope-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Test',
      })
      .expect(201);
    ownerToken = res.body.data.accessToken;

    const branches = await asOwner(http().get('/branches')).expect(200);
    branchA = branches.body.data.items[0].id;
    branchB = (
      await asOwner(
        http().post('/branches').send({ name: 'Branch B', slug: 'branch-b' }),
      ).expect(201)
    ).body.data.id;

    const invited = await asOwner(
      http()
        .post('/users')
        .send({
          email: `module-scope-manager-${Date.now()}@example.com`,
          firstName: 'Branch',
          lastName: 'Manager',
          primaryBranchId: branchA,
          roleKey: 'BRANCH_MANAGER',
          roleBranchId: branchA,
        }),
    ).expect(201);
    await prisma.user.update({
      where: { id: invited.body.data.id },
      data: { status: 'ACTIVE' },
    });
    managerToken = app.get(TokensService).signAccessToken(invited.body.data.id);

    const makeMember = async (branchId: string, firstName: string) =>
      (
        await asOwner(
          http()
            .post('/members')
            .send({ primaryBranchId: branchId, firstName, lastName: 'Scope' }),
        ).expect(201)
      ).body.data.id as string;
    memberA = await makeMember(branchA, 'Alpha');
    memberB = await makeMember(branchB, 'Bravo');
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('lists only their branch’s members in a segment', async () => {
    const segment = await asOwner(
      // No rules: everyone in this new gym, so both members match.
      http()
        .post('/members/segments')
        .send({
          name: `Everyone ${Date.now()}`,
          rules: [],
        }),
    ).expect(201);
    const id = segment.body.data.id ?? segment.body.data.segment?.id;

    const managerView = await asManager(
      http().get(`/members/segments/${id}/members`),
    ).expect(200);
    const ids = managerView.body.data.members.map(
      (m: { memberId: string }) => m.memberId,
    );
    expect(ids).toContain(memberA);
    expect(ids).not.toContain(memberB);
    expect(managerView.body.data.totalCount).toBe(1);

    const ownerView = await asOwner(
      http().get(`/members/segments/${id}/members`),
    ).expect(200);
    expect(ownerView.body.data.totalCount).toBe(2);
  });

  it('hides another branch’s member intelligence', async () => {
    await asManager(http().get(`/members/${memberB}/intelligence`)).expect(404);
    await asManager(http().get(`/members/${memberA}/intelligence`)).expect(200);
  });

  it('hides another branch’s lead score', async () => {
    const leadB = await asOwner(
      http()
        .post('/leads')
        .send({ firstName: 'Lead', lastName: 'Bravo', branchId: branchB }),
    ).expect(201);
    await asManager(http().get(`/leads/${leadB.body.data.id}/score`)).expect(
      404,
    );
  });

  it('reads only their branch’s audit entries', async () => {
    // Something audited in each branch.
    for (const [id, branch] of [
      [memberA, branchA],
      [memberB, branchB],
    ]) {
      await authed(
        ownerToken,
        branch,
      )(http().patch(`/members/${id}`).send({ notes: 'audited' })).expect(200);
    }
    const log = await asManager(http().get('/audit-logs')).expect(200);
    const branchIds = new Set(
      log.body.data.items.map((r: { branchId: string | null }) => r.branchId),
    );
    expect([...branchIds]).toEqual([branchA]);
  });

  it('does not schedule classes in another branch', async () => {
    await asManager(
      http().post('/classes/programs').send({
        branchId: branchB,
        name: 'Not Mine',
        capacity: 10,
        durationMinutes: 45,
      }),
    ).expect(400);
  });

  it('does not hand out another branch member’s entry code', async () => {
    await asManager(http().get(`/attendance/qr-token/${memberB}`)).expect(404);
    await asManager(
      http().post(`/attendance/qr-token/${memberB}/rotate`),
    ).expect(404);
    await asManager(http().get(`/attendance/qr-token/${memberA}`)).expect(200);
  });

  it('does not register or revoke another branch’s kiosk', async () => {
    await asManager(
      http().post('/devices').send({ branchId: branchB, name: 'Door B' }),
    ).expect(400);
    const deviceB = await asOwner(
      http().post('/devices').send({ branchId: branchB, name: 'Door B' }),
    ).expect(201);
    await asManager(
      http().post(`/devices/${deviceB.body.data.id}/revoke`),
    ).expect(404);
    const row = await prisma.kioskDevice.findUniqueOrThrow({
      where: { id: deviceB.body.data.id },
    });
    expect(row.active).toBe(true);
  });

  it('does not touch another branch member’s loyalty points', async () => {
    await asManager(http().get(`/loyalty/${memberB}`)).expect(404);
    await asManager(
      http()
        .post(`/loyalty/${memberB}/adjust`)
        .send({ points: 100, reason: 'test' }),
    ).expect(404);
  });

  it('keeps the org-wide ledger from a one-branch grant', async () => {
    await asManager(http().get('/accounting/trial-balance')).expect(403);
    await asOwner(http().get('/accounting/trial-balance')).expect(200);
  });
});
