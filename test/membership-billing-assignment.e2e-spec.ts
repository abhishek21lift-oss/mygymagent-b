import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * `GET /members/:id/membership-billing` allows `members.read_assigned`
 * but never applied the assignment predicate: any trainer could read any
 * in-branch member's billing by substituting the member id. This suite
 * pins the intended scope -- assigned-only for `read_assigned` holders,
 * unchanged org-wide access for broad roles, and cross-org denial.
 */
describe('Membership billing assignment scoping (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokensService;
  let owner: RegisteredAccount;
  let trainerId: string;
  let trainerToken: string;
  let assignedMemberId: string;
  let unassignedMemberId: string;
  let otherTrainerMemberId: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asTrainer = (req: request.Test) => authed(trainerToken)(req);
  const asOwner = (req: request.Test) => authed(owner.accessToken)(req);

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    tokens = app.get(TokensService);

    const email = `billing-scope-owner-${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Billing Scoping Test Gym',
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
    const branchId = branches.body.data.items[0].id;
    owner.branchId = branchId;

    const trainerEmail = `billing-trainer-${Date.now()}@example.com`;
    const invited = await asOwner(
      request(app.getHttpServer()).post('/users').send({
        email: trainerEmail,
        firstName: 'Test',
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
    trainerToken = tokens.signAccessToken(trainerId);

    const otherTrainer = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `billing-other-${Date.now()}@example.com`,
          firstName: 'Other',
          lastName: 'Trainer',
          primaryBranchId: branchId,
          roleKey: 'TRAINER',
          isTrainer: true,
        }),
    ).expect(201);

    const assignedMember = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Assigned',
        lastName: 'Billing',
        assignedTrainerId: trainerId,
      }),
    ).expect(201);
    assignedMemberId = assignedMember.body.data.id;

    const unassignedMember = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Nobodys',
        lastName: 'Billing',
      }),
    ).expect(201);
    unassignedMemberId = unassignedMember.body.data.id;

    const otherTrainerMember = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Someone',
        lastName: 'ElsesBilling',
        assignedTrainerId: otherTrainer.body.data.id,
      }),
    ).expect(201);
    otherTrainerMemberId = otherTrainerMember.body.data.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('lets a trainer read billing for their assigned member', async () => {
    const res = await asTrainer(
      request(app.getHttpServer()).get(
        `/members/${assignedMemberId}/membership-billing`,
      ),
    ).expect(200);
    expect(res.body.data).toHaveProperty('outstandingBalance');
  });

  it('denies a trainer billing for an unassigned same-branch member', async () => {
    await asTrainer(
      request(app.getHttpServer()).get(
        `/members/${unassignedMemberId}/membership-billing`,
      ),
    ).expect(404);
  });

  it('denies a trainer billing for another trainer member', async () => {
    await asTrainer(
      request(app.getHttpServer()).get(
        `/members/${otherTrainerMemberId}/membership-billing`,
      ),
    ).expect(404);
  });

  it('keeps org-wide access for the owner on every member', async () => {
    for (const id of [
      assignedMemberId,
      unassignedMemberId,
      otherTrainerMemberId,
    ]) {
      await asOwner(
        request(app.getHttpServer()).get(`/members/${id}/membership-billing`),
      ).expect(200);
    }
  });

  it('denies cross-organization billing access', async () => {
    const other = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: `Billing Other Gym ${Date.now()}`,
        email: `billing-other-gym-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Other',
        lastName: 'Owner',
      })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/members/${assignedMemberId}/membership-billing`)
      .set('Authorization', `Bearer ${other.body.data.accessToken}`)
      .expect(404);
  });
});
