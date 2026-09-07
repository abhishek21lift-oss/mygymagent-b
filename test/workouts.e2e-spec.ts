import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Workouts (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let exerciseId: string;
  let memberId: string;

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

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    org = await registerOrg('Workouts Test Gym');

    const exercise = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/exercises')
        .send({ name: 'Back Squat', muscleGroup: 'Legs' }),
    ).expect(201);
    exerciseId = exercise.body.data.id;

    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Trainee',
        lastName: 'One',
      }),
    ).expect(201);
    memberId = member.body.data.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('rejects a duplicate exercise name within the same org', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/exercises')
        .send({ name: 'Back Squat' }),
    ).expect(409);
  });

  it('rejects a workout plan referencing an unknown exerciseId', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/workout-plans')
        .send({
          name: 'Bad plan',
          exercises: [
            {
              exerciseId: '00000000-0000-0000-0000-000000000000',
              order: 1,
              sets: 3,
              reps: '10',
            },
          ],
        }),
    ).expect(400);
  });

  it('creates a workout plan, assigns it to a member, and updates assignment status', async () => {
    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/workout-plans')
        .send({
          name: 'Beginner Strength',
          description: '3x/week full body',
          exercises: [
            {
              exerciseId,
              order: 1,
              sets: 5,
              reps: '5',
              restSeconds: 120,
            },
          ],
        }),
    ).expect(201);
    expect(plan.body.data.exercises).toHaveLength(1);

    const assignment = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/workout-plans/${plan.body.data.id}/assign`)
        .send({ memberId, notes: 'Start light' }),
    ).expect(201);
    expect(assignment.body.data.status).toBe('ACTIVE');
    expect(assignment.body.data.memberId).toBe(memberId);

    const list = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/workout-assignments')
        .query({ memberId }),
    ).expect(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].workoutPlan.name).toBe('Beginner Strength');

    const updated = await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/workout-assignments/${assignment.body.data.id}/status`)
        .send({ status: 'COMPLETED' }),
    ).expect(200);
    expect(updated.body.data.status).toBe('COMPLETED');

    // Terminal states are frozen: COMPLETED cannot go back to ACTIVE.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/workout-assignments/${assignment.body.data.id}/status`)
        .send({ status: 'ACTIVE' }),
    ).expect(400);
  });

  it('rejects assigning a plan to a member that does not exist', async () => {
    const plan = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/workout-plans').send({
        name: 'Another plan',
        exercises: [],
      }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/workout-plans/${plan.body.data.id}/assign`)
        .send({ memberId: '00000000-0000-0000-0000-000000000000' }),
    ).expect(404);
  });

  it('returns logged sets through the exercise-history join', async () => {
    // Regression: the history query used to target a schema that never
    // shipped (snake_case columns, workout_sets/workout_session_exercises
    // tables) and 500'd on every call. This drives a real session -> set
    // -> history read through the live endpoint.
    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/workout-plans')
        .send({
          name: 'History Regression Plan',
          exercises: [{ exerciseId, order: 1, sets: 2, reps: '8' }],
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
    const snapshotExerciseId = session.body.data.exercises[0].id;

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(
          `/workout-sessions/${session.body.data.id}/exercises/${snapshotExerciseId}/sets`,
        )
        .send({ setNumber: 1, weightKg: 60, reps: 8 }),
    ).expect(201);

    const history = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/workouts/exercise-history')
        .query({ memberId, exerciseId, limit: 10 }),
    ).expect(200);

    const rows = history.body.data;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].weight_kg).toBe('60');
    expect(rows[0].reps).toBe(8);
    expect(rows[0].set_number).toBe(1);
  });

  it('returns 404 from exercise-history for another org member or exercise', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/workouts/exercise-history')
        .query({
          memberId: '00000000-0000-0000-0000-000000000000',
          exerciseId,
        }),
    ).expect(404);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/workouts/exercise-history')
        .query({
          memberId,
          exerciseId: '00000000-0000-0000-0000-000000000000',
        }),
    ).expect(404);
  });
});
