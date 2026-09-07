import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * PT session lifecycle: booking (with trainer/branch/org validation and
 * overlap conflicts), the status transition law (only SCHEDULED may move
 * to a terminal state; terminal states are frozen), and assignment
 * scoping for trainers (pt-sessions.read_assigned sees only sessions of
 * members assigned to them).
 */
describe('PT sessions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokensService;
  let owner: RegisteredAccount;
  let branchId: string;
  let trainerId: string;
  let trainerToken: string;
  let memberId: string;
  let unassignedMemberId: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(owner.accessToken)(req);
  const asTrainer = (req: request.Test) => authed(trainerToken)(req);

  const todayAt = (hour: number) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    tokens = app.get(TokensService);

    const email = `pt-sessions-owner-${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'PT Sessions Test Gym',
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
    branchId = branches.body.data.items[0].id;
    owner.branchId = branchId;

    const trainerEmail = `pt-trainer-${Date.now()}@example.com`;
    const invited = await asOwner(
      request(app.getHttpServer()).post('/users').send({
        email: trainerEmail,
        firstName: 'Pt',
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

    const member = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Pt',
        lastName: 'Client',
        assignedTrainerId: trainerId,
      }),
    ).expect(201);
    memberId = member.body.data.id;

    const unassigned = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Unassigned',
        lastName: 'Client',
      }),
    ).expect(201);
    unassignedMemberId = unassigned.body.data.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('books a session and rejects overlapping ones for the same member', async () => {
    const booked = await asOwner(
      request(app.getHttpServer()).post('/pt-sessions').send({
        memberId,
        branchId,
        startTime: todayAt(10),
        endTime: todayAt(11),
      }),
    ).expect(201);
    expect(booked.body.data.status).toBe('SCHEDULED');

    await asOwner(
      request(app.getHttpServer()).post('/pt-sessions').send({
        memberId,
        branchId,
        startTime: todayAt(10),
        endTime: todayAt(11),
      }),
    ).expect(400);
  });

  it('rejects booking for a member from another org', async () => {
    await asOwner(
      request(app.getHttpServer()).post('/pt-sessions').send({
        memberId: '00000000-0000-0000-0000-000000000000',
        branchId,
        startTime: todayAt(14),
        endTime: todayAt(15),
      }),
    ).expect(400);
  });

  it('rejects invalid transitions from terminal states', async () => {
    const booked = await asOwner(
      request(app.getHttpServer()).post('/pt-sessions').send({
        memberId,
        branchId,
        startTime: todayAt(12),
        endTime: todayAt(13),
      }),
    ).expect(201);
    const id = booked.body.data.id;

    // SCHEDULED -> COMPLETED is valid.
    await asOwner(
      request(app.getHttpServer()).patch(`/pt-sessions/${id}/complete`),
    ).expect(200);

    // COMPLETED -> CANCELLED must be rejected (would also try to consume
    // a second package session).
    await asOwner(
      request(app.getHttpServer()).patch(`/pt-sessions/${id}/cancel`),
    ).expect(400);

    // COMPLETED -> NO_SHOW must be rejected.
    await asOwner(
      request(app.getHttpServer()).patch(`/pt-sessions/${id}/no-show`),
    ).expect(400);

    // Terminal -> SCHEDULED must be rejected.
    await asOwner(
      request(app.getHttpServer()).patch(`/pt-sessions/${id}`).send({
        status: 'SCHEDULED',
      }),
    ).expect(400);
  });

  it('rejects transitioning a cancelled session to completed', async () => {
    const booked = await asOwner(
      request(app.getHttpServer()).post('/pt-sessions').send({
        memberId,
        branchId,
        startTime: todayAt(16),
        endTime: todayAt(17),
      }),
    ).expect(201);
    const id = booked.body.data.id;

    await asOwner(
      request(app.getHttpServer()).patch(`/pt-sessions/${id}/cancel`),
    ).expect(200);

    await asOwner(
      request(app.getHttpServer()).patch(`/pt-sessions/${id}/complete`),
    ).expect(400);
  });

  it('assignment-scopes trainer reads to their own members', async () => {
    // Owner books for both members; the trainer only sees the assigned one.
    const assigned = await asOwner(
      request(app.getHttpServer()).post('/pt-sessions').send({
        memberId,
        branchId,
        startTime: todayAt(18),
        endTime: todayAt(19),
      }),
    ).expect(201);
    await asOwner(
      request(app.getHttpServer()).post('/pt-sessions').send({
        memberId: unassignedMemberId,
        branchId,
        startTime: todayAt(18),
        endTime: todayAt(19),
      }),
    ).expect(201);

    const list = await asTrainer(
      request(app.getHttpServer()).get('/pt-sessions'),
    ).expect(200);
    const memberIds = new Set(
      list.body.data.items.map((s: { memberId: string }) => s.memberId),
    );
    expect(memberIds.has(memberId)).toBe(true);
    expect(memberIds.has(unassignedMemberId)).toBe(false);

    // Single-session read is scoped too: the unassigned member's session
    // must 404 for the trainer while the assigned one is readable.
    const unassignedList = await asOwner(
      request(app.getHttpServer()).get('/pt-sessions'),
    ).expect(200);
    const unassignedSession = unassignedList.body.data.items.find(
      (s: { memberId: string }) => s.memberId === unassignedMemberId,
    );
    await asTrainer(
      request(app.getHttpServer()).get(
        `/pt-sessions/${unassignedSession.id}`,
      ),
    ).expect(404);
    await asTrainer(
      request(app.getHttpServer()).get(`/pt-sessions/${assigned.body.data.id}`),
    ).expect(200);
  });
});
