import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * The TRAINER role holds `members.read_assigned`, not the broader
 * `members.read` -- see roles.catalog.ts. This suite proves that
 * distinction is actually enforced end to end (not just granted and
 * ignored): a trainer can only read members where
 * Member.assignedTrainerId is their own id, via both the list and
 * single-resource endpoints, while a broad `members.read` holder (the
 * org owner) still sees everyone.
 *
 * The invited trainer is activated directly via Prisma and issued a token
 * via TokensService, same shortcut as branch-scoping.e2e-spec.ts -- this
 * suite is about authorization, not invite/accept UX.
 */
describe('Member assignment scoping (e2e)', () => {
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
    app = await createTestApp();
    prisma = app.get(PrismaService);
    tokens = app.get(TokensService);

    const email = `assignment-scope-owner-${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Assignment Scoping Test Gym',
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

    const trainerEmail = `trainer-${Date.now()}@example.com`;
    const invited = await asOwner(
      request(app.getHttpServer()).post('/users').send({
        email: trainerEmail,
        firstName: 'Test',
        lastName: 'Trainer',
        primaryBranchId: branchId,
        roleKey: 'TRAINER',
      }),
    ).expect(201);
    trainerId = invited.body.data.id;
    await prisma.user.update({
      where: { id: trainerId },
      data: { status: 'ACTIVE' },
    });
    trainerToken = tokens.signAccessToken(trainerId);

    const otherTrainerEmail = `other-trainer-${Date.now()}@example.com`;
    const otherTrainer = await asOwner(
      request(app.getHttpServer()).post('/users').send({
        email: otherTrainerEmail,
        firstName: 'Other',
        lastName: 'Trainer',
        primaryBranchId: branchId,
        roleKey: 'TRAINER',
      }),
    ).expect(201);

    const assignedMember = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Assigned',
        lastName: 'ToMe',
        assignedTrainerId: trainerId,
      }),
    ).expect(201);
    assignedMemberId = assignedMember.body.data.id;

    const unassignedMember = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Nobodys',
        lastName: 'Client',
      }),
    ).expect(201);
    unassignedMemberId = unassignedMember.body.data.id;

    const otherTrainerMember = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Someone',
        lastName: 'ElsesClient',
        assignedTrainerId: otherTrainer.body.data.id,
      }),
    ).expect(201);
    otherTrainerMemberId = otherTrainerMember.body.data.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("a trainer's member list contains only their own assigned members", async () => {
    const list = await asTrainer(
      request(app.getHttpServer()).get('/members'),
    ).expect(200);
    const ids = list.body.data.items.map((m: { id: string }) => m.id);
    expect(ids).toContain(assignedMemberId);
    expect(ids).not.toContain(unassignedMemberId);
    expect(ids).not.toContain(otherTrainerMemberId);
  });

  it('a trainer can read their own assigned member by id', async () => {
    await asTrainer(
      request(app.getHttpServer()).get(`/members/${assignedMemberId}`),
    ).expect(200);
  });

  it("a trainer cannot read an unassigned member or another trainer's member by id", async () => {
    await asTrainer(
      request(app.getHttpServer()).get(`/members/${unassignedMemberId}`),
    ).expect(404);
    await asTrainer(
      request(app.getHttpServer()).get(`/members/${otherTrainerMemberId}`),
    ).expect(404);
  });

  it('a broad members.read holder (the org owner) still sees every member, assigned or not', async () => {
    const list = await asOwner(
      request(app.getHttpServer()).get('/members'),
    ).expect(200);
    const ids = list.body.data.items.map((m: { id: string }) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        assignedMemberId,
        unassignedMemberId,
        otherTrainerMemberId,
      ]),
    );
    await asOwner(
      request(app.getHttpServer()).get(`/members/${unassignedMemberId}`),
    ).expect(200);
  });
});
