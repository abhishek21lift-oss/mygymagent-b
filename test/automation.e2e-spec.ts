import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { LeadFollowupScanner } from '../src/automation/scanners/lead-followup.scanner';
import { MemberInactiveScanner } from '../src/automation/scanners/member-inactive.scanner';
import { MembershipRenewalScanner } from '../src/automation/scanners/membership-renewal.scanner';
import { PaymentOverdueScanner } from '../src/automation/scanners/payment-overdue.scanner';
import { QUEUE_NAMES } from '../src/queue/queue.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';
import { waitForEmailTo } from './utils/mailbox';

/**
 * Exercises each automation scanner's actual trigger condition and
 * cooldown against real Postgres data and a real SMTP send (see
 * test/utils/smtp-capture-server.ts) -- not the BullMQ cron schedule
 * itself (AutomationSchedulerService just calls BullMQ's own
 * upsertJobScheduler, which is BullMQ's tested behavior, not this app's).
 * Scanners are invoked directly via `app.get()` rather than waiting on
 * the daily schedule to fire, the same way other e2e specs call services
 * directly when the thing under test isn't reachable over HTTP.
 */
describe('Automation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let org: RegisteredAccount;
  let ownerEmail: string;

  async function registerOrg(name: string): Promise<RegisteredAccount> {
    const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.com`;
    ownerEmail = email;
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
    prisma = app.get(PrismaService);
    org = await registerOrg('Automation Test Gym');
  });

  afterAll(async () => {
    await app.close();
  });

  it('reminds a member whose membership expires within the window, then respects cooldown', async () => {
    const email = `renew-${Date.now()}@example.com`;
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Renewing',
        lastName: 'Member',
        email,
      }),
    ).expect(201);

    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Expiring Soon', durationDays: 5, price: 49.99 }),
    ).expect(201);

    const membership = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/memberships').send({
        memberId: member.body.data.id,
        membershipPlanId: plan.body.data.id,
      }),
    ).expect(201);

    const scanner = app.get(MembershipRenewalScanner);
    const first = await scanner.scan();
    expect(first.sent).toBeGreaterThanOrEqual(1);

    const sentEmail = await waitForEmailTo(email);
    expect(sentEmail.subject).toContain('expiring soon');

    const runs = await prisma.automationRun.findMany({
      where: {
        organizationId: org.organizationId,
        key: 'MEMBERSHIP_RENEWAL_REMINDER',
        subjectId: membership.body.data.id,
      },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('SENT');

    // Same membership, still in the window -- cooldown must suppress a
    // second reminder rather than emailing the member again immediately.
    await scanner.scan();
    const runsAfterSecondScan = await prisma.automationRun.count({
      where: {
        organizationId: org.organizationId,
        key: 'MEMBERSHIP_RENEWAL_REMINDER',
        subjectId: membership.body.data.id,
      },
    });
    expect(runsAfterSecondScan).toBe(1);
  });

  it('reminds a member about a short-paid membership, computed from real Payment/Refund rows', async () => {
    const email = `overdue-${Date.now()}@example.com`;
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'ShortPaid',
        lastName: 'Member',
        email,
      }),
    ).expect(201);

    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Full Price Plan', durationDays: 30, price: 100 }),
    ).expect(201);

    const membership = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/memberships').send({
        memberId: member.body.data.id,
        membershipPlanId: plan.body.data.id,
      }),
    ).expect(201);

    // Only 40 of the 100 owed has been paid -- a real outstanding balance
    // computed from Payment rows, not a fabricated invoice/due-date.
    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId: member.body.data.id,
        membershipId: membership.body.data.id,
        amount: 40,
      }),
    ).expect(201);

    const scanner = app.get(PaymentOverdueScanner);
    const result = await scanner.scan();
    expect(result.sent).toBeGreaterThanOrEqual(1);

    const sentEmail = await waitForEmailTo(email);
    expect(sentEmail.body).toContain('60.00');

    const run = await prisma.automationRun.findFirst({
      where: {
        organizationId: org.organizationId,
        key: 'PAYMENT_OVERDUE_REMINDER',
        subjectId: membership.body.data.id,
      },
    });
    expect(run?.status).toBe('SENT');
  });

  it('does not remind a member who has fully paid their membership', async () => {
    const email = `paid-in-full-${Date.now()}@example.com`;
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'PaidUp',
        lastName: 'Member',
        email,
      }),
    ).expect(201);

    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Prepaid Plan', durationDays: 30, price: 75 }),
    ).expect(201);

    const membership = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/memberships').send({
        memberId: member.body.data.id,
        membershipPlanId: plan.body.data.id,
      }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId: member.body.data.id,
        membershipId: membership.body.data.id,
        amount: 75,
      }),
    ).expect(201);

    const scanner = app.get(PaymentOverdueScanner);
    await scanner.scan();

    const run = await prisma.automationRun.findFirst({
      where: {
        organizationId: org.organizationId,
        key: 'PAYMENT_OVERDUE_REMINDER',
        subjectId: membership.body.data.id,
      },
    });
    expect(run).toBeNull();
  });

  it('sends a re-engagement email to a member inactive past the threshold', async () => {
    const email = `inactive-${Date.now()}@example.com`;
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Ghost',
        lastName: 'Member',
        email,
      }),
    ).expect(201);

    // The REST API has no way to backdate joinedAt (nor should it) --
    // going straight to Prisma to set up state the API can't express is
    // the same pattern test/permission-override-precedence.e2e-spec.ts
    // uses for the same reason.
    await prisma.member.update({
      where: { id: member.body.data.id },
      data: { joinedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) },
    });

    // MARKETING-category send (see the scanner's class comment) --
    // without an explicit grant, CommunicationsService.send() would
    // correctly skip it (SKIPPED_NO_CONSENT), so consent has to be
    // recorded for this test to reach an actual send.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/members/${member.body.data.id}/consents`)
        .send({ type: 'MARKETING', granted: true }),
    ).expect(201);

    const scanner = app.get(MemberInactiveScanner);
    const result = await scanner.scan();
    expect(result.sent).toBeGreaterThanOrEqual(1);

    const sentEmail = await waitForEmailTo(email);
    expect(sentEmail.subject.toLowerCase()).toContain('miss you');

    const run = await prisma.automationRun.findFirst({
      where: {
        organizationId: org.organizationId,
        key: 'MEMBER_INACTIVE_RECOVERY',
        subjectId: member.body.data.id,
      },
    });
    expect(run?.status).toBe('SENT');
  });

  it('records SKIPPED, not SENT, for an inactive member with no MARKETING consent', async () => {
    const email = `no-consent-${Date.now()}@example.com`;
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Unreachable',
        lastName: 'Member',
        email,
      }),
    ).expect(201);

    await prisma.member.update({
      where: { id: member.body.data.id },
      data: { joinedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) },
    });

    const scanner = app.get(MemberInactiveScanner);
    const result = await scanner.scan();
    expect(result.sent).toBe(0);

    const run = await prisma.automationRun.findFirst({
      where: {
        organizationId: org.organizationId,
        key: 'MEMBER_INACTIVE_RECOVERY',
        subjectId: member.body.data.id,
      },
    });
    expect(run?.status).toBe('SKIPPED');
  });

  it('reminds the assigned staff member about an overdue lead follow-up', async () => {
    const lead = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'Overdue',
        lastName: 'Prospect',
        assignedToUserId: org.userId,
      }),
    ).expect(201);

    const followUp = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/leads/${lead.body.data.id}/follow-ups`)
        .send({
          dueAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          note: 'Was supposed to call yesterday',
        }),
    ).expect(201);

    const scanner = app.get(LeadFollowupScanner);
    const result = await scanner.scan();
    expect(result.sent).toBeGreaterThanOrEqual(1);

    const sentEmail = await waitForEmailTo(ownerEmail);
    expect(sentEmail.body).toContain('Overdue Prospect');

    const run = await prisma.automationRun.findFirst({
      where: {
        organizationId: org.organizationId,
        key: 'LEAD_FOLLOWUP_REMINDER',
        subjectId: followUp.body.data.id,
      },
    });
    expect(run?.status).toBe('SENT');
  });

  it('alerts inventory.manage holders in real time when stock crosses the reorder level', async () => {
    const product = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/products')
        .send({
          sku: `LOW-${Date.now()}`,
          name: 'Protein Bar',
          unitPrice: 3,
          quantityOnHand: 5,
          reorderLevel: 3,
        }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${product.body.data.id}/stock-movements`)
        .send({ type: 'SALE', quantity: 3 }),
    ).expect(201);

    const queue = app.get<Queue>(getQueueToken(QUEUE_NAMES.AUTOMATION));
    await waitForJobCount(async () => {
      const completed = await queue.getJobs(['completed']);
      return completed.some(
        (job) =>
          job.name === 'send-low-stock-alert' &&
          job.data.productId === product.body.data.id,
      );
    });

    const sentEmail = await waitForEmailTo(ownerEmail);
    expect(sentEmail.subject).toContain('Protein Bar');

    const run = await prisma.automationRun.findFirst({
      where: {
        organizationId: org.organizationId,
        key: 'LOW_STOCK_ALERT',
        subjectId: { startsWith: `${product.body.data.id}:` },
      },
    });
    expect(run?.status).toBe('SENT');
  });
});
