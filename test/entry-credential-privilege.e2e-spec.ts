import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokensService } from '../src/auth/tokens.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P0-9 (BACKLOG.md): minting a gym entry credential is not a read.
 *
 * `GET /attendance/qr-token/:memberId` returns a working QR token for the
 * turnstile. It used to accept `members.read` as well as
 * `attendance.create`, which made issuing a durable entry credential a
 * *lower* bar than recording a single check-in with one — exactly
 * backwards. Roles that only ever read a member profile to do their job
 * (the accountant reconciling payments, the sales executive chasing a
 * lead, the nutritionist writing a diet plan) could mint physical access
 * to the building.
 *
 * What these cases pin down is both halves of the narrowing: the roles
 * that should not have it no longer do, and every role that actually
 * works the door still does.
 */
describe('Entry credential privilege (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokensService;

  let ownerToken: string;
  let branchId: string;
  let memberId: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);

  /** Creates a staff user on `roleKey` and returns a usable access token. */
  const staffToken = async (roleKey: string): Promise<string> => {
    const created = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `qr-${roleKey.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`,
          firstName: roleKey,
          lastName: 'User',
          primaryBranchId: branchId,
          roleKey,
        }),
    ).expect(201);
    await prisma.user.update({
      where: { id: created.body.data.id },
      data: { status: 'ACTIVE' },
    });
    return tokens.signAccessToken(created.body.data.id);
  };

  const mint = (token: string) =>
    authed(token)(
      request(app.getHttpServer()).get(`/attendance/qr-token/${memberId}`),
    );

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    tokens = app.get(TokensService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Entry Credential Gym',
        email: `qr-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Quinn',
        lastName: 'Owner',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    const member = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Mika',
        lastName: 'Member',
      }),
    ).expect(201);
    memberId = member.body.data.id;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe('roles that only read member profiles', () => {
    // Each of these holds `members.read` and no `attendance.create*`.
    it.each([['ACCOUNTANT'], ['SALES_EXECUTIVE'], ['NUTRITIONIST']])(
      '%s cannot mint an entry credential',
      async (roleKey) => {
        const token = await staffToken(roleKey);

        // The role genuinely can read the member -- this is a narrowing of
        // one route, not a loss of the read access the job needs.
        await authed(token)(
          request(app.getHttpServer()).get(`/members/${memberId}`),
        ).expect(200);

        await mint(token).expect(403);
      },
    );
  });

  describe('roles that work the door', () => {
    it.each([['RECEPTIONIST'], ['BRANCH_MANAGER'], ['HEAD_TRAINER']])(
      '%s can still mint an entry credential',
      async (roleKey) => {
        const token = await staffToken(roleKey);
        const res = await mint(token).expect(200);
        expect(res.body.data.token).toBeTruthy();
        expect(res.body.data.memberId).toBe(memberId);
      },
    );

    it('the owner can still mint one', async () => {
      const res = await mint(ownerToken).expect(200);
      expect(res.body.data.token).toBeTruthy();
    });
  });

  it('mints a credential that is not the same one twice', async () => {
    // The route always rotates; only the hash is stored, so a second call
    // must not be able to hand back the first plaintext token.
    const first = await mint(ownerToken).expect(200);
    const second = await mint(ownerToken).expect(200);
    expect(second.body.data.token).not.toBe(first.body.data.token);
  });

  it('records the mint in the audit trail', async () => {
    // Issuing building access is exactly the kind of act that has to be
    // attributable after the fact.
    await mint(ownerToken).expect(200);
    const entry = await prisma.auditLog.findFirst({
      where: { resource: 'member_qr_token' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).not.toBeNull();
  });
});
