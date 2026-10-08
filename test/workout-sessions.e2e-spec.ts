import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * A session on the floor, as the trainer app drives it: start from an
 * assignment, log sets against the session's exercises, finish, read the
 * history back. Starting the same assignment twice resumes the running
 * session -- a double tap must not open a second one that splits the sets.
 */
describe('Workout sessions (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let memberId: string;
  let exerciseId: string;
  let assignmentId: string;

  const server = () => app.getHttpServer();
  const as = (req: request.Test) =>
    req.set('Authorization', `Bearer ${org.accessToken}`);

  beforeAll(async () => {
    app = (await createTestApp()).app;
    const email = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const reg = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Workout Sessions Gym',
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Sessions',
      })
      .expect(201);
    org = {
      accessToken: reg.body.data.accessToken,
      organizationId: reg.body.data.organization.id,
      userId: reg.body.data.user.id,
      branchId: '',
    };
    const branches = await as(request(server()).get('/branches')).expect(200);
    org.branchId = branches.body.data.items[0].id;

    exerciseId = (
      await as(
        request(server())
          .post('/exercises')
          .send({ name: 'Back Squat', muscleGroup: 'Legs' }),
      ).expect(201)
    ).body.data.id;
    memberId = (
      await as(
        request(server()).post('/members').send({
          primaryBranchId: org.branchId,
          firstName: 'Lifter',
          lastName: 'One',
        }),
      ).expect(201)
    ).body.data.id;
    const plan = await as(
      request(server())
        .post('/workout-plans')
        .send({
          name: 'Squat day',
          exercises: [{ exerciseId, order: 1, sets: 3, reps: '5' }],
        }),
    ).expect(201);
    assignmentId = (
      await as(
        request(server())
          .post(`/workout-plans/${plan.body.data.id}/assign`)
          .send({ memberId }),
      ).expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('starts, resumes on a second start, logs sets, completes and shows in history', async () => {
    const started = await as(
      request(server())
        .post(`/workout-sessions/assignment/${assignmentId}/start`)
        .send({}),
    ).expect(201);
    const session = started.body.data;
    expect(session.status).toBe('IN_PROGRESS');
    expect(session.exercises).toHaveLength(1);
    expect(session.exercises[0]).toMatchObject({
      exerciseId,
      exerciseName: 'Back Squat',
      setsTarget: 3,
      repsTarget: '5',
    });

    const again = await as(
      request(server())
        .post(`/workout-sessions/assignment/${assignmentId}/start`)
        .send({}),
    ).expect(201);
    expect(again.body.data.id).toBe(session.id);

    const sessionExerciseId = session.exercises[0].id;
    const logged = await as(
      request(server())
        .post(
          `/workout-sessions/${session.id}/exercises/${sessionExerciseId}/sets`,
        )
        .send({ setNumber: 1, weightKg: 180, reps: 5, rpe: 8 }),
    ).expect(201);
    expect(logged.body.data.sets).toHaveLength(1);
    expect(logged.body.data.sets[0]).toMatchObject({
      sessionExerciseId,
      setNumber: 1,
      reps: 5,
    });

    const done = await as(
      request(server())
        .patch(`/workout-sessions/${session.id}/complete`)
        .send({}),
    ).expect(200);
    expect(done.body.data.status).toBe('COMPLETED');

    const history = await as(
      request(server()).get(`/workout-sessions/member/${memberId}/history`),
    ).expect(200);
    expect(history.body.data.map((s: { id: string }) => s.id)).toContain(
      session.id,
    );

    const exerciseHistory = await as(
      request(server())
        .get('/workouts/exercise-history')
        .query({ memberId, exerciseId }),
    ).expect(200);
    expect(exerciseHistory.body.data).toHaveLength(1);
    expect(Number(exerciseHistory.body.data[0].weight_kg)).toBe(180);
  });

  it('opens a new session once the previous one is completed', async () => {
    const today = await as(
      request(server()).get('/workout-sessions/today'),
    ).expect(200);
    const previous = (
      today.body.data as Array<{ id: string; assignmentId: string }>
    ).find((s) => s.assignmentId === assignmentId);
    const next = await as(
      request(server())
        .post(`/workout-sessions/assignment/${assignmentId}/start`)
        .send({}),
    ).expect(201);
    expect(next.body.data.status).toBe('IN_PROGRESS');
    expect(next.body.data.id).not.toBe(previous?.id);
  });
});
