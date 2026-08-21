import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Member Assessments & Goals (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let orgB: RegisteredAccount;
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
    org = await registerOrg('Assess Goals Test Gym');
    orgB = await registerOrg('Assess Goals Test Gym B');

    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Alex',
        lastName: 'Athlete',
      }),
    ).expect(201);
    memberId = member.body.data.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('assessments', () => {
    let assessmentId: string;

    it('creates an assessment session', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/assessments`)
          .send({ type: 'INITIAL', notes: 'First visit assessment' }),
      ).expect(201);
      expect(res.body.data.type).toBe('INITIAL');
      assessmentId = res.body.data.id;
    });

    it('records a measurement linked to the assessment, and rejects a foreign assessmentId', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/measurements`)
          .send({ assessmentId, weightKg: 78.5, bodyFatPercent: 18.2 }),
      ).expect(201);
      expect(Number(res.body.data.weightKg)).toBeCloseTo(78.5);

      await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/measurements`)
          .send({ assessmentId: 'not-a-real-assessment-id', weightKg: 70 }),
      ).expect(404);
    });

    it('records a standalone measurement with no assessmentId', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/measurements`)
          .send({ weightKg: 79 }),
      ).expect(201);

      const list = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/measurements`),
      ).expect(200);
      expect(list.body.data.length).toBeGreaterThanOrEqual(2);
    });

    it('records a fitness test result', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/fitness-tests`)
          .send({
            testName: '1RM Bench Press',
            value: 80,
            unit: 'kg',
            assessmentId,
          }),
      ).expect(201);
      expect(res.body.data.testName).toBe('1RM Bench Press');
    });

    it('records a PAR-Q screening', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/screenings`)
          .send({
            responses: {
              hasHeartCondition: false,
              chestPainDuringActivity: false,
            },
            flaggedForMedicalClearance: false,
          }),
      ).expect(201);
      expect(res.body.data.flaggedForMedicalClearance).toBe(false);
    });

    it('lists assessments with nested measurements/fitness results/screening', async () => {
      const list = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/assessments`),
      ).expect(200);
      const found = list.body.data.find(
        (a: { id: string }) => a.id === assessmentId,
      );
      expect(found).toBeDefined();
      expect(found.measurements.length).toBeGreaterThan(0);
      expect(found.fitnessResults.length).toBeGreaterThan(0);
    });
  });

  describe('goals', () => {
    let goalId: string;

    it('creates a goal', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer()).post(`/members/${memberId}/goals`).send({
          title: 'Lose 5kg',
          category: 'WEIGHT_LOSS',
          targetValue: 73,
          targetUnit: 'kg',
          baselineValue: 78.5,
        }),
      ).expect(201);
      expect(res.body.data.status).toBe('ACTIVE');
      goalId = res.body.data.id;
    });

    it('adds a milestone and marks it achieved', async () => {
      const milestone = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/goals/${goalId}/milestones`)
          .send({ title: 'Lost first 2kg', value: 76.5 }),
      ).expect(201);
      expect(milestone.body.data.achievedAt).toBeNull();

      const achieved = await authed(org.accessToken)(
        request(app.getHttpServer())
          .patch(
            `/members/${memberId}/goals/${goalId}/milestones/${milestone.body.data.id}`,
          )
          .send({ achievedAt: new Date().toISOString() }),
      ).expect(200);
      expect(achieved.body.data.achievedAt).not.toBeNull();
    });

    it('marks the goal achieved and sets achievedAt', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer())
          .patch(`/members/${memberId}/goals/${goalId}`)
          .send({ status: 'ACHIEVED' }),
      ).expect(200);
      expect(res.body.data.status).toBe('ACHIEVED');
      expect(res.body.data.achievedAt).not.toBeNull();
    });

    it('lists goals with nested milestones', async () => {
      const list = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/goals`),
      ).expect(200);
      const found = list.body.data.find((g: { id: string }) => g.id === goalId);
      expect(found.milestones.length).toBeGreaterThan(0);
    });
  });

  describe('cross-tenant isolation', () => {
    it("rejects org B reading or writing org A's member assessments/goals", async () => {
      await authed(orgB.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/assessments`),
      ).expect(404);

      await authed(orgB.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/goals`)
          .send({ title: 'Should not be allowed' }),
      ).expect(404);
    });
  });
});
