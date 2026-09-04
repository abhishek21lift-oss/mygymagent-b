import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Workout Sessions (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let otherOrg: RegisteredAccount;
  let assignmentId: string;
  let sessionId: string;

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

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  async function seedActiveAssignment(token: string): Promise<string> {
    const exercise = await authed(token)(
      request(app.getHttpServer())
        .post('/exercises')
        .send({ name: `Back Squat ${Math.random().toString(36).slice(2, 8)}` }),
    ).expect(201);

    const member = await authed(token)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Trainee',
        lastName: 'Session',
      }),
    ).expect(201);

    const plan = await authed(token)(
      request(app.getHttpServer())
        .post('/workout-plans')
        .send({
          name: `Execution Plan ${Math.random().toString(36).slice(2, 8)}`,
          exercises: [
            {
              exerciseId: exercise.body.data.id,
              order: 1,
              sets: 3,
              reps: '8-12',
              restSeconds: 90,
            },
          ],
        }),
    ).expect(201);

    const assignment = await authed(token)(
      request(app.getHttpServer())
        .post(`/workout-plans/${plan.body.data.id}/assign`)
        .send({ memberId: member.body.data.id }),
    ).expect(201);
    return assignment.body.data.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    org = await registerOrg('Workout Sessions Gym');
    otherOrg = await registerOrg('Workout Sessions Other Gym');
    assignmentId = await seedActiveAssignment(org.accessToken);
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts a session from an active assignment, snapshotted from the plan', async () => {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/workout-sessions/assignment/${assignmentId}/start`)
        .send({}),
    ).expect(201);

    expect(res.body.data.status).toBe('IN_PROGRESS');
    expect(res.body.data.assignmentId).toBe(assignmentId);
    expect(res.body.data.exercises).toHaveLength(1);
    expect(res.body.data.exercises[0]).toMatchObject({
      exerciseName: expect.stringMatching(/^Back Squat/),
      setsTarget: 3,
      repsTarget: '8-12',
      restSeconds: 90,
      displayOrder: 1,
    });
    expect(res.body.data.exercises[0].id).toBeTruthy();
    sessionId = res.body.data.id;
  });

  it('lists today’s sessions with member and plan names', async () => {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/workout-sessions/today'),
    ).expect(200);

    const session = res.body.data.find(
      (s: { id: string }) => s.id === sessionId,
    );
    expect(session).toBeTruthy();
    expect(session.firstName).toBe('Trainee');
    expect(session.workoutPlanName).toMatch(/^Execution Plan/);
  });

  it('logs sets idempotently (re-logging the same set number updates in place)', async () => {
    const sessionExerciseId = (
      await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/workout-sessions/${sessionId}`),
      ).expect(200)
    ).body.data.exercises[0].id;

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(
          `/workout-sessions/${sessionId}/exercises/${sessionExerciseId}/sets`,
        )
        .send({ setNumber: 1, weightKg: 60, reps: 10, rpe: 7 }),
    ).expect(201);

    const afterFirst = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/workout-sessions/${sessionId}`),
    ).expect(200);
    expect(afterFirst.body.data.sets).toHaveLength(1);
    expect(afterFirst.body.data.sets[0]).toMatchObject({
      sessionExerciseId,
      setNumber: 1,
      weightKg: '60',
      reps: 10,
    });

    // Same set number again → updates the same row, no duplicate.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(
          `/workout-sessions/${sessionId}/exercises/${sessionExerciseId}/sets`,
        )
        .send({ setNumber: 1, weightKg: 65, reps: 8, rpe: 8 }),
    ).expect(201);

    const afterUpsert = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/workout-sessions/${sessionId}`),
    ).expect(200);
    expect(afterUpsert.body.data.sets).toHaveLength(1);
    expect(afterUpsert.body.data.sets[0].weightKg).toBe('65');
  });

  it('rejects logging a set for an exercise outside the session snapshot', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(
          `/workout-sessions/${sessionId}/exercises/00000000-0000-0000-0000-000000000000/sets`,
        )
        .send({ setNumber: 1, reps: 5 }),
    ).expect(400);
  });

  it('completes the session and then rejects further set logging', async () => {
    const completed = await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/workout-sessions/${sessionId}/complete`)
        .send({}),
    ).expect(200);
    expect(completed.body.data.status).toBe('COMPLETED');
    expect(completed.body.data.completedAt).toBeTruthy();

    const sessionExerciseId = completed.body.data.exercises[0].id;
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(
          `/workout-sessions/${sessionId}/exercises/${sessionExerciseId}/sets`,
        )
        .send({ setNumber: 2, reps: 8 }),
    ).expect(400);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/workout-sessions/${sessionId}/complete`)
        .send({}),
    ).expect(400);
  });

  it('rejects starting a session from a non-active assignment', async () => {
    const otherAssignmentId = await seedActiveAssignment(org.accessToken);
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/workout-assignments/${otherAssignmentId}/status`)
        .send({ status: 'COMPLETED' }),
    ).expect(200);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/workout-sessions/assignment/${otherAssignmentId}/start`)
        .send({}),
    ).expect(400);
  });

  it('never leaks a session across tenants', async () => {
    await authed(otherOrg.accessToken)(
      request(app.getHttpServer()).get(`/workout-sessions/${sessionId}`),
    ).expect(404);
    await authed(otherOrg.accessToken)(
      request(app.getHttpServer()).get('/workout-sessions/today'),
    ).expect(200);
    expect(
      (
        await authed(otherOrg.accessToken)(
          request(app.getHttpServer()).get('/workout-sessions/today'),
        )
      ).body.data.some((s: { id: string }) => s.id === sessionId),
    ).toBe(false);
  });

  it('scopes a trainer’s session reads to their own assigned members', async () => {
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokensService);

    // Invite + activate a TRAINER and mint a token directly, the same
    // shortcut the member-assignment-scoping suite uses.
    const trainerEmail = `session-trainer-${Date.now()}@example.com`;
    const invited = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/users').send({
        email: trainerEmail,
        firstName: 'Scoped',
        lastName: 'Trainer',
        primaryBranchId: org.branchId,
        roleKey: 'TRAINER',
      }),
    ).expect(201);
    const trainerUserId = invited.body.data.id;
    await prisma.user.update({
      where: { id: trainerUserId },
      data: { status: 'ACTIVE' },
    });
    const trainerToken = tokens.signAccessToken(trainerUserId);

    const mine = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Mine',
        lastName: 'Client',
        assignedTrainerId: trainerUserId,
      }),
    ).expect(201);
    const other = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Someone',
        lastName: 'ElsesClient',
      }),
    ).expect(201);

    const startFor = async (memberId: string) => {
      const exercise = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post('/exercises')
          .send({ name: `Squat ${Math.random().toString(36).slice(2, 8)}` }),
      ).expect(201);
      const plan = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post('/workout-plans')
          .send({
            name: `Plan ${Math.random().toString(36).slice(2, 8)}`,
            exercises: [
              {
                exerciseId: exercise.body.data.id,
                order: 1,
                sets: 3,
                reps: '8',
              },
            ],
          }),
      ).expect(201);
      const assignment = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/workout-plans/${plan.body.data.id}/assign`)
          .send({ memberId }),
      ).expect(201);
      const session = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/workout-sessions/assignment/${assignment.body.data.id}/start`)
          .send({}),
      ).expect(201);
      return session.body.data.id as string;
    };

    const mineSessionId = await startFor(mine.body.data.id);
    const otherSessionId = await startFor(other.body.data.id);

    // The trainer only sees their own client's session in the day list...
    const today = await authed(trainerToken)(
      request(app.getHttpServer()).get('/workout-sessions/today'),
    ).expect(200);
    const ids = today.body.data.map((s: { id: string }) => s.id);
    expect(ids).toContain(mineSessionId);
    expect(ids).not.toContain(otherSessionId);

    // ...and can open their own client's session but not the other's.
    await authed(trainerToken)(
      request(app.getHttpServer()).get(`/workout-sessions/${mineSessionId}`),
    ).expect(200);
    await authed(trainerToken)(
      request(app.getHttpServer()).get(`/workout-sessions/${otherSessionId}`),
    ).expect(404);
  });
});
