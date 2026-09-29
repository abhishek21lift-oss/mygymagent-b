import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { LeadFollowupScanner } from '../src/automation/scanners/lead-followup.scanner';
import { MemberInactiveScanner } from '../src/automation/scanners/member-inactive.scanner';
import { MembershipRenewalScanner } from '../src/automation/scanners/membership-renewal.scanner';
import { PaymentOverdueScanner } from '../src/automation/scanners/payment-overdue.scanner';
import { AutomationScanProcessor } from '../src/automation/automation-scan.processor';
import { AutomationRunService } from '../src/automation/automation-run.service';
import { JOB_NAMES, QUEUE_NAMES } from '../src/queue/queue.constants';
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
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    org = await registerOrg('Automation Test Gym');
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
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

    // Matched on the subject, because creating the member above also fired
    // a welcome email at this address.
    const sentEmail = await waitForEmailTo(email, 5000, (candidate) =>
      candidate.subject.includes('expiring soon'),
    );
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

    // Matched on the amount. Creating the member above also fired a
    // welcome email at this address, so "the newest email" is a race
    // between the two — the same hazard the "miss you" case documents.
    const sentEmail = await waitForEmailTo(email, 5000, (candidate) =>
      candidate.body.includes('60.00'),
    );
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

    // Creating the member also fires a welcome email from an event
    // listener, so this address receives two messages with no guaranteed
    // order. Match on the one this test is actually about.
    const sentEmail = await waitForEmailTo(email, 5000, (candidate) =>
      candidate.subject.toLowerCase().includes('miss you'),
    );
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

    // Matched for the same reason as the low-stock case: the owner address
    // collects every automation email this suite sends.
    const sentEmail = await waitForEmailTo(ownerEmail, 5000, (candidate) =>
      candidate.body.includes('Overdue Prospect'),
    );
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

  it('lets a failed send be retried instead of spending the cooldown on it', async () => {
    const runs = app.get(AutomationRunService);
    const subjectId = `failed-send-${Date.now()}`;

    // What production did on 25 September: SMTP unset, so the send threw.
    const first = await runs.attempt(
      org.organizationId,
      'PAYMENT_OVERDUE_REMINDER',
      subjectId,
      5,
      () => Promise.reject(new Error('Email is not configured')),
    );
    expect(first).toBe('FAILED');

    // Nobody was reached, so the next scan has to be allowed to try again.
    // It used to answer COOLDOWN here for five days.
    const second = await runs.attempt(
      org.organizationId,
      'PAYMENT_OVERDUE_REMINDER',
      subjectId,
      5,
      () => Promise.resolve({ status: 'SENT' }),
    );
    expect(second).toBe('SENT');

    // A real send does still buy the cooldown.
    const third = await runs.attempt(
      org.organizationId,
      'PAYMENT_OVERDUE_REMINDER',
      subjectId,
      5,
      () => Promise.resolve({ status: 'SENT' }),
    );
    expect(third).toBe('COOLDOWN');
  });

  it('scores active members on the nightly risk job without anyone clicking', async () => {
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Nightly',
        lastName: 'Scored',
      }),
    ).expect(201);

    const before = await prisma.memberRiskProfile.findFirst({
      where: { memberId: member.body.data.id },
    });
    expect(before).toBeNull();

    const processor = app.get(AutomationScanProcessor);
    const result = (await processor.process({
      name: JOB_NAMES.SCAN_RISK_PROFILES,
      data: {},
    } as never)) as { organizations: number; processed: number };

    expect(result.organizations).toBeGreaterThanOrEqual(1);
    expect(result.processed).toBeGreaterThanOrEqual(1);

    const after = await prisma.memberRiskProfile.findFirst({
      where: { memberId: member.body.data.id },
    });
    expect(after).not.toBeNull();
  }, 120_000);

  it('runs data retention when its daily job fires, and never deletes an access override', async () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

    const spent = await prisma.passwordResetToken.create({
      data: {
        userId: org.userId,
        tokenHash: `retention-${Date.now()}-${Math.random()}`,
        expiresAt: old,
        usedAt: old,
        createdAt: old,
      },
    });

    // A DENY an administrator set over a year ago, still meant to deny.
    const permission = await prisma.permission.findFirstOrThrow({
      where: { key: 'members.delete' },
    });
    const deny = await prisma.userPermissionOverride.create({
      data: {
        userId: org.userId,
        permissionId: permission.id,
        organizationId: org.organizationId,
        effect: 'DENY',
        createdAt: old,
      },
    });

    // Before its case existed this fell through to "Unrecognized job
    // name" and deleted nothing, every day.
    await app
      .get(AutomationScanProcessor)
      .process({ name: JOB_NAMES.SCAN_DATA_RETENTION, data: {} } as never);

    expect(
      await prisma.passwordResetToken.findUnique({ where: { id: spent.id } }),
    ).toBeNull();
    expect(
      await prisma.userPermissionOverride.findUnique({
        where: { id: deny.id },
      }),
    ).not.toBeNull();

    await prisma.userPermissionOverride.delete({ where: { id: deny.id } });
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

    // Matched rather than "whatever is newest to the owner": every
    // automation in this suite mails the same address. The original
    // failure read `Expected "Protein Bar", Received "Follow up due:
    // Overdue Prospect"`, which looked like cross-test contamination but
    // is not — the low-stock email was never sent at all in those runs.
    // See B-P1-10. The matcher makes a recurrence report a timeout naming
    // this address instead of pointing at the wrong email.
    const sentEmail = await waitForEmailTo(ownerEmail, 5000, (candidate) =>
      candidate.subject.includes('Protein Bar'),
    );
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
