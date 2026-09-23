import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, grantActiveMembership } from './utils/test-app';

/**
 * B-P1-8: the enrolment surface for the biometric turnstile.
 *
 * `DeviceMap` maps a scanner's own identifier for a person -- the
 * `externalUserId` it sends when a finger is read -- to a member. Nothing
 * in the codebase ever wrote one: no endpoint, no import, no seed. So
 * `POST /devices/check-in` found a mapping for nobody and answered
 * `{allowed:false, reason:"unenrolled device user"}` in every deployment,
 * forever.
 *
 * Three things had to be true for a turnstile to admit anyone, and they
 * arrived one at a time: the route had to exist (B-P0-5 registered the
 * controller, which was declared in no module), the device had to have a
 * credential it could present (B-P0-13 moved it onto the hashed registry,
 * having found that the branch key it used had no write path either), and
 * the person had to be enrolled. This suite is the third, and the case
 * that matters most is `admits an enrolled member` -- the first time a
 * biometric check-in succeeds end to end.
 */
describe('Turnstile enrolment (e2e, B-P1-8)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let branchId: string;
  let otherBranchId: string;
  let turnstileKey: string;
  let memberId: string;
  let otherMemberId: string;
  let trainerToken: string;
  let trainerId: string;
  let assignedMemberId: string;
  let accountantToken: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);
  const asTrainer = (req: request.Test) => authed(trainerToken)(req);

  const enrol = (body: Record<string, unknown>) =>
    asOwner(
      request(app.getHttpServer()).post('/attendance/enrolments').send(body),
    );

  const scan = (externalUserId: string, key = turnstileKey) =>
    request(app.getHttpServer())
      .post('/devices/check-in')
      .send({ deviceKey: key, externalUserId });

  const newMember = async (firstName: string, assignedTrainerId?: string) => {
    const res = await asOwner(
      request(app.getHttpServer())
        .post('/members')
        .send({
          primaryBranchId: branchId,
          firstName,
          lastName: 'Turnstile',
          ...(assignedTrainerId ? { assignedTrainerId } : {}),
        }),
    ).expect(201);
    await grantActiveMembership(app, ownerToken, res.body.data.id);
    return res.body.data.id as string;
  };

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Enrolment Test Gym',
        email: `enrolment-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Enrolment',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    const second = await asOwner(
      request(app.getHttpServer())
        .post('/branches')
        .send({ name: 'North Branch', slug: `north-${Date.now()}` }),
    ).expect(201);
    otherBranchId = second.body.data.id;

    const device = await asOwner(
      request(app.getHttpServer())
        .post('/devices')
        .send({ branchId, name: 'Front Turnstile', kind: 'BIOMETRIC' }),
    ).expect(201);
    turnstileKey = device.body.data.key;

    const invited = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `enrolment-trainer-${Date.now()}@example.com`,
          firstName: 'Tess',
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

    // ACCOUNTANT holds no attendance permission at all -- the negative
    // fixture for "who may grant entry to the building".
    const accountant = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `enrolment-accountant-${Date.now()}@example.com`,
          firstName: 'Abe',
          lastName: 'Accountant',
          primaryBranchId: branchId,
          roleKey: 'ACCOUNTANT',
          roleBranchId: branchId,
        }),
    ).expect(201);
    await prisma.user.update({
      where: { id: accountant.body.data.id },
      data: { status: 'ACTIVE' },
    });
    accountantToken = app
      .get(TokensService)
      .signAccessToken(accountant.body.data.id);

    memberId = await newMember('Ravi');
    otherMemberId = await newMember('Sana');
    assignedMemberId = await newMember('Client', trainerId);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('admits an enrolled member through the turnstile', async () => {
    // The whole point of B-P1-8. Before it, this returned
    // `{allowed:false, reason:"unenrolled device user"}` for everyone.
    const externalUserId = `finger-${Date.now()}`;
    const created = await enrol({
      branchId,
      memberId,
      externalUserId,
    }).expect(201);
    expect(created.body.data.member.id).toBe(memberId);

    const res = await scan(externalUserId).expect(200);
    expect(res.body.data.allowed).toBe(true);
    expect(res.body.data.memberId).toBe(memberId);
    expect(res.body.data.method).toBe('BIOMETRIC');

    // And it is an ordinary attendance row, the same as one typed in at
    // the front desk -- which is what B-P0-5 was about.
    const row = await prisma.attendance.findUniqueOrThrow({
      where: { id: res.body.data.id },
      select: { memberId: true, branchId: true, method: true },
    });
    expect(row).toEqual({ memberId, branchId, method: 'BIOMETRIC' });
  });

  it('still refuses an id nobody is enrolled on', async () => {
    const res = await scan(`unknown-${Date.now()}`).expect(200);
    expect(res.body.data.allowed).toBe(false);
    expect(res.body.data.reason).toBe('unenrolled device user');
  });

  it('is idempotent about re-enrolling the same member on the same id', async () => {
    const externalUserId = `repeat-${Date.now()}`;
    const first = await enrol({ branchId, memberId, externalUserId }).expect(
      201,
    );
    const second = await enrol({ branchId, memberId, externalUserId }).expect(
      201,
    );
    expect(second.body.data.id).toBe(first.body.data.id);

    expect(
      await prisma.deviceMap.count({ where: { branchId, externalUserId } }),
    ).toBe(1);
  });

  it('refuses to re-point an id at a different member', async () => {
    // Scanners reuse ids when someone is removed from the hardware.
    // Silently transferring building access from one member to another is
    // not something an enrolment call should do by accident, so this is a
    // conflict the operator has to resolve deliberately.
    const externalUserId = `reused-${Date.now()}`;
    await enrol({ branchId, memberId, externalUserId }).expect(201);
    await enrol({ branchId, memberId: otherMemberId, externalUserId }).expect(
      409,
    );

    const mapping = await prisma.deviceMap.findFirstOrThrow({
      where: { branchId, externalUserId },
      select: { memberId: true },
    });
    expect(mapping.memberId).toBe(memberId);
  });

  it('frees the id once the old enrolment is removed', async () => {
    const externalUserId = `handover-${Date.now()}`;
    const created = await enrol({
      branchId,
      memberId,
      externalUserId,
    }).expect(201);

    await asOwner(
      request(app.getHttpServer()).delete(
        `/attendance/enrolments/${created.body.data.id}`,
      ),
    ).expect(200);

    await enrol({ branchId, memberId: otherMemberId, externalUserId }).expect(
      201,
    );
    const res = await scan(externalUserId).expect(200);
    expect(res.body.data.allowed).toBe(true);
    expect(res.body.data.memberId).toBe(otherMemberId);
  });

  it('stops admitting a member whose enrolment is removed', async () => {
    const externalUserId = `revoked-${Date.now()}`;
    const created = await enrol({
      branchId,
      memberId,
      externalUserId,
    }).expect(201);
    await scan(externalUserId).expect(200);

    await asOwner(
      request(app.getHttpServer()).delete(
        `/attendance/enrolments/${created.body.data.id}`,
      ),
    ).expect(200);

    const after = await scan(externalUserId).expect(200);
    expect(after.body.data.allowed).toBe(false);
    expect(after.body.data.reason).toBe('unenrolled device user');
  });

  it('keeps enrolments to the branch they were made on', async () => {
    // The same person can carry different ids at different branches, and
    // an id enrolled at one branch means nothing at another -- the unique
    // key is (organization, branch, externalUserId).
    const externalUserId = `branchy-${Date.now()}`;
    await enrol({
      branchId: otherBranchId,
      memberId,
      externalUserId,
    }).expect(201);

    const res = await scan(externalUserId).expect(200);
    expect(res.body.data.allowed).toBe(false);
    expect(res.body.data.reason).toBe('unenrolled device user');
  });

  describe('listing', () => {
    it('filters by member and by branch', async () => {
      const byMember = await asOwner(
        request(app.getHttpServer())
          .get('/attendance/enrolments')
          .query({ memberId }),
      ).expect(200);
      expect(byMember.body.data.length).toBeGreaterThan(0);
      expect(
        byMember.body.data.every(
          (e: { memberId: string }) => e.memberId === memberId,
        ),
      ).toBe(true);

      const byBranch = await asOwner(
        request(app.getHttpServer())
          .get('/attendance/enrolments')
          .query({ branchId: otherBranchId }),
      ).expect(200);
      expect(
        byBranch.body.data.every(
          (e: { branchId: string }) => e.branchId === otherBranchId,
        ),
      ).toBe(true);
    });

    it('names the member, since an external id alone tells an operator nothing', async () => {
      const list = await asOwner(
        request(app.getHttpServer())
          .get('/attendance/enrolments')
          .query({ memberId }),
      ).expect(200);
      expect(list.body.data[0].member.firstName).toBe('Ravi');
    });
  });

  describe('who may grant entry', () => {
    it('lets a trainer enrol their own client but not someone else’s', async () => {
      const mine = await asTrainer(
        request(app.getHttpServer())
          .post('/attendance/enrolments')
          .send({
            branchId,
            memberId: assignedMemberId,
            externalUserId: `trainer-ok-${Date.now()}`,
          }),
      ).expect(201);
      expect(mine.body.data.memberId).toBe(assignedMemberId);

      // Same 404 as a member in another organization -- an enrolment is a
      // durable entry credential, so assignment scope applies exactly as
      // it does to minting a QR token (B-P0-9).
      await asTrainer(
        request(app.getHttpServer())
          .post('/attendance/enrolments')
          .send({
            branchId,
            memberId: otherMemberId,
            externalUserId: `trainer-no-${Date.now()}`,
          }),
      ).expect(404);
    });

    it('shows a trainer only their own clients’ enrolments', async () => {
      const list = await asTrainer(
        request(app.getHttpServer()).get('/attendance/enrolments'),
      ).expect(200);
      const memberIds = list.body.data.map(
        (e: { memberId: string }) => e.memberId,
      );
      expect(memberIds).toContain(assignedMemberId);
      expect(memberIds).not.toContain(otherMemberId);
    });

    it('denies a role that holds no attendance permission', async () => {
      await authed(accountantToken)(
        request(app.getHttpServer())
          .post('/attendance/enrolments')
          .send({
            branchId,
            memberId,
            externalUserId: `accountant-${Date.now()}`,
          }),
      ).expect(403);
    });
  });

  it('refuses a branch or a member outside the organization', async () => {
    await enrol({
      branchId: '00000000-0000-0000-0000-000000000000',
      memberId,
      externalUserId: `nobranch-${Date.now()}`,
    }).expect(404);

    await enrol({
      branchId,
      memberId: '00000000-0000-0000-0000-000000000000',
      externalUserId: `nomember-${Date.now()}`,
    }).expect(404);
  });
});
