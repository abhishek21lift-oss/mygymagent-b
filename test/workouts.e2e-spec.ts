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
  });

  it('reads back one workout plan and edits it, replacing the exercise list', async () => {
    const second = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/exercises')
        .send({
          name: `Romanian Deadlift ${Date.now()}`,
          muscleGroup: 'Hamstrings',
        }),
    ).expect(201);

    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/workout-plans')
        .send({
          name: 'Editable Plan',
          exercises: [{ exerciseId, order: 1, sets: 3, reps: '8-12' }],
        }),
    ).expect(201);
    const planId = plan.body.data.id;

    const detail = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/workout-plans/${planId}`),
    ).expect(200);
    expect(detail.body.data.name).toBe('Editable Plan');
    expect(detail.body.data.exercises).toHaveLength(1);

    // The edit form sends the whole exercise list back and renumbers `order`
    // from the rendered order, so removing the middle row leaves no gap.
    const updated = await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/workout-plans/${planId}`)
        .send({
          name: 'Edited Plan',
          description: 'Reworked for the off-season',
          exercises: [
            {
              exerciseId: second.body.data.id,
              order: 1,
              sets: 5,
              reps: '5',
              restSeconds: 180,
            },
          ],
        }),
    ).expect(200);

    expect(updated.body.data.name).toBe('Edited Plan');
    expect(updated.body.data.description).toBe('Reworked for the off-season');
    expect(updated.body.data.exercises).toHaveLength(1);
    expect(updated.body.data.exercises[0].exerciseId).toBe(second.body.data.id);
    expect(updated.body.data.exercises[0].sets).toBe(5);
  });

  it('refuses to edit a workout plan onto an exercise from another org', async () => {
    const otherOrg = await registerOrg('Workout Isolation Gym');
    const foreignExercise = await authed(otherOrg.accessToken)(
      request(app.getHttpServer())
        .post('/exercises')
        .send({ name: `Foreign Press ${Date.now()}` }),
    ).expect(201);

    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/workout-plans')
        .send({
          name: 'Isolation Plan',
          exercises: [{ exerciseId, order: 1, sets: 3, reps: '10' }],
        }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/workout-plans/${plan.body.data.id}`)
        .send({
          exercises: [
            {
              exerciseId: foreignExercise.body.data.id,
              order: 1,
              sets: 3,
              reps: '10',
            },
          ],
        }),
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
});
