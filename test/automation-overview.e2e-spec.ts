import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/** GET /automation -- the screen nine background jobs never had. */
describe('Automation overview (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let org: RegisteredAccount;
  let other: RegisteredAccount;

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
    prisma = app.get(PrismaService);
    org = await registerOrg('Automation Overview Gym');
    other = await registerOrg('Automation Overview Other Gym');
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('lists every job, including the nightly risk scoring and data retention', async () => {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/automation'),
    ).expect(200);

    const scanners = res.body.data.scanners as Array<{
      title: string;
      job: string | null;
      cadence: string;
      channelReady: boolean;
    }>;
    const titles = scanners.map((scanner) => scanner.title);
    expect(titles).toContain('Overdue payment reminders');
    expect(titles).toContain('Churn risk scoring');
    expect(titles).toContain('Data retention');

    const risk = scanners.find(
      (scanner) => scanner.title === 'Churn risk scoring',
    )!;
    expect(risk.cadence).toBe('Nightly');

    // The test deployment runs a capture SMTP server, so email is live here.
    expect(res.body.data.channels.email).toBe(true);
  });

  it('groups failures by reason and names who each run was about', async () => {
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Owes',
        lastName: 'Money',
      }),
    ).expect(201);
    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Overview Plan', durationDays: 30, price: 2000 }),
    ).expect(201);
    const membership = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/memberships').send({
        memberId: member.body.data.id,
        membershipPlanId: plan.body.data.id,
      }),
    ).expect(201);

    // Exactly what production recorded on 25 September.
    const reason =
      'Email is not configured on this deployment (SMTP_HOST/SMTP_FROM_ADDRESS unset).';
    for (let i = 0; i < 3; i++) {
      await prisma.automationRun.create({
        data: {
          organizationId: org.organizationId,
          key: 'PAYMENT_OVERDUE_REMINDER',
          subjectId: membership.body.data.id,
          status: 'FAILED',
          detail: { error: reason, outstanding: '2000.00' },
        },
      });
    }

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/automation'),
    ).expect(200);

    const blockers = res.body.data.blockers as Array<{
      reason: string;
      count: number;
    }>;
    const blocker = blockers.find((b) => b.reason === reason);
    expect(blocker?.count).toBe(3);

    const overdue = (
      res.body.data.scanners as Array<{
        key: string | null;
        outcomes: { FAILED: number };
      }>
    ).find((scanner) => scanner.key === 'PAYMENT_OVERDUE_REMINDER')!;
    expect(overdue.outcomes.FAILED).toBe(3);

    const recent = res.body.data.recent as Array<{
      subjectLabel: string | null;
      memberId: string | null;
    }>;
    // A membership id is not something an owner can act on; a name is.
    expect(recent[0].subjectLabel).toBe('Owes Money');
    expect(recent[0].memberId).toBe(member.body.data.id);
  });

  it('never shows one gym another gym failures', async () => {
    await prisma.automationRun.create({
      data: {
        organizationId: other.organizationId,
        key: 'MEMBERSHIP_RENEWAL_REMINDER',
        subjectId: 'someone-elses-membership',
        status: 'FAILED',
        detail: { error: 'Other gym only' },
      },
    });

    const ours = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/automation'),
    ).expect(200);
    expect(JSON.stringify(ours.body.data)).not.toContain('Other gym only');

    const theirs = await authed(other.accessToken)(
      request(app.getHttpServer()).get('/automation'),
    ).expect(200);
    expect(
      (theirs.body.data.blockers as Array<{ reason: string }>).map(
        (b) => b.reason,
      ),
    ).toContain('Other gym only');
  });
});
