import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { JOB_NAMES, QUEUE_NAMES } from '../src/queue/queue.constants';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Notifications queue (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let queue: Queue;

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

  async function waitForJobCount(
    predicate: () => Promise<boolean>,
    timeoutMs = 5000,
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for job condition');
  }

  beforeAll(async () => {
    app = await createTestApp();
    queue = app.get<Queue>(getQueueToken(QUEUE_NAMES.NOTIFICATIONS));
    org = await registerOrg('Queue Test Gym');
  });

  afterAll(async () => {
    await app.close();
  });

  it('enqueues and processes a welcome-email job when a member with an email is created', async () => {
    const email = `welcome-${Date.now()}@example.com`;
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Jamie',
        lastName: 'NewMember',
        email,
      }),
    ).expect(201);

    await waitForJobCount(async () => {
      const completed = await queue.getJobs(['completed']);
      return completed.some(
        (job) =>
          job.name === JOB_NAMES.SEND_WELCOME_EMAIL &&
          (job.data as { memberId: string }).memberId === member.body.data.id,
      );
    });
  });

  it('does not enqueue a job when the member has no email on file', async () => {
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'NoEmail',
        lastName: 'Member',
      }),
    ).expect(201);

    // Give any (incorrect) enqueue a moment to happen, then confirm it didn't.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const allJobs = await queue.getJobs([
      'completed',
      'active',
      'waiting',
      'delayed',
    ]);
    expect(
      allJobs.some(
        (job) =>
          (job.data as { memberId?: string }).memberId === member.body.data.id,
      ),
    ).toBe(false);
  });
});
