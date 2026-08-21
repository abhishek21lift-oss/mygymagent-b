import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Nutrition (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let foodItemId: string;
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
    app = await createTestApp();
    org = await registerOrg('Nutrition Test Gym');

    const foodItem = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/food-items')
        .send({ name: 'Chicken Breast', calories: 165, proteinG: 31 }),
    ).expect(201);
    foodItemId = foodItem.body.data.id;

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
    await app.close();
  });

  it('rejects a duplicate food item name within the same org', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/food-items')
        .send({ name: 'Chicken Breast' }),
    ).expect(409);
  });

  it('rejects a diet plan referencing an unknown foodItemId', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/diet-plans')
        .send({
          name: 'Bad plan',
          items: [
            {
              foodItemId: '00000000-0000-0000-0000-000000000000',
              mealSlot: 'LUNCH',
              quantity: 1,
              unit: 'serving',
            },
          ],
        }),
    ).expect(400);
  });

  it('creates a diet plan, assigns it to a member, and updates assignment status', async () => {
    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/diet-plans')
        .send({
          name: 'High Protein',
          description: 'Cut phase',
          items: [
            {
              foodItemId,
              mealSlot: 'LUNCH',
              quantity: 200,
              unit: 'g',
            },
          ],
          targetCalories: 2200,
        }),
    ).expect(201);
    expect(plan.body.data.items).toHaveLength(1);
    expect(plan.body.data.targetCalories).toBe(2200);

    const assignment = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/diet-plans/${plan.body.data.id}/assign`)
        .send({ memberId, notes: 'Start next Monday' }),
    ).expect(201);
    expect(assignment.body.data.status).toBe('ACTIVE');
    expect(assignment.body.data.memberId).toBe(memberId);

    const list = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/diet-assignments').query({ memberId }),
    ).expect(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].dietPlan.name).toBe('High Protein');

    const updated = await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/diet-assignments/${assignment.body.data.id}/status`)
        .send({ status: 'COMPLETED' }),
    ).expect(200);
    expect(updated.body.data.status).toBe('COMPLETED');
  });

  it('rejects assigning a plan to a member that does not exist', async () => {
    const plan = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/diet-plans').send({
        name: 'Another plan',
        items: [],
      }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/diet-plans/${plan.body.data.id}/assign`)
        .send({ memberId: '00000000-0000-0000-0000-000000000000' }),
    ).expect(404);
  });
});
