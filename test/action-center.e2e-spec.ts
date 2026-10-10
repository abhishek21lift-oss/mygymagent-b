import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CallAnalysisService } from '../src/action-center/call-analysis.service';
import { TaskGeneratorService } from '../src/action-center/task-generator.service';
import { OpenRouterProvider } from '../src/ai/providers/openrouter.provider';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestApp,
  grantActiveMembership,
  type RegisteredAccount,
} from './utils/test-app';

/**
 * Daily Action Center, end to end against real Postgres: the generator
 * puts a payment follow-up on the list, a receptionist calls and logs the
 * member's promise, the AI's suggestion is approved into a task, a real
 * payment closes everything, and re-running the generator adds nothing.
 * Around it: tenant isolation, role rules, and the AI failure paths.
 */
describe('Action Center (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokensService;
  let generator: TaskGeneratorService;
  let analysis: CallAnalysisService;
  let provider: OpenRouterProvider;
  let org: RegisteredAccount;
  let other: RegisteredAccount;
  let receptionist: RegisteredAccount;
  let trainer: RegisteredAccount;
  let memberId: string;
  let membershipId: string;

  const http = () => request(app.getHttpServer());
  const as = (account: RegisteredAccount) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${account.accessToken}`);

  async function registerOrg(name: string): Promise<RegisteredAccount> {
    const email = `ac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const res = await http()
      .post('/auth/register')
      .send({
        organizationName: name,
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: name,
      })
      .expect(201);
    const branches = await http()
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

  async function staff(
    roleKey: string,
    firstName: string,
  ): Promise<RegisteredAccount> {
    const invited = await as(org)(
      http()
        .post('/users')
        .send({
          email: `ac-${roleKey.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
          firstName,
          lastName: 'Staff',
          primaryBranchId: org.branchId,
          roleKey,
        }),
    ).expect(201);
    const id = invited.body.data.id;
    await prisma.user.update({ where: { id }, data: { status: 'ACTIVE' } });
    return {
      accessToken: tokens.signAccessToken(id),
      organizationId: org.organizationId,
      userId: id,
      branchId: org.branchId,
    };
  }

  function istDate(offsetDays: number): string {
    const d = new Date(Date.now() + offsetDays * 86_400_000);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
  }

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    tokens = app.get(TokensService);
    generator = app.get(TaskGeneratorService);
    analysis = app.get(CallAnalysisService);
    provider = app.get(OpenRouterProvider);

    org = await registerOrg('Action Center Gym');
    other = await registerOrg('Other Gym');
    await prisma.organization.updateMany({
      where: { id: { in: [org.organizationId, other.organizationId] } },
      data: { timezone: 'Asia/Kolkata' },
    });
    receptionist = await staff('RECEPTIONIST', 'Riya');
    trainer = await staff('TRAINER', 'Tarun');

    const member = await as(org)(
      http().post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Pooja',
        lastName: 'Dues',
        phone: '+919800000001',
      }),
    ).expect(201);
    memberId = member.body.data.id;
    // Five days left and nothing paid: a renewal call and a dues call.
    ({ membershipId } = await grantActiveMembership(
      app,
      org.accessToken,
      memberId,
      5,
    ));
  });

  afterAll(async () => {
    await app.close();
  });

  let duesTaskId: string;

  it('generates a renewal and a dues task from real records, once', async () => {
    const first = await as(org)(http().post('/action-center/generate')).expect(
      201,
    );
    expect(first.body.data.created).toBeGreaterThanOrEqual(2);

    const tasks = await prisma.task.findMany({
      where: { organizationId: org.organizationId, memberId },
      select: { id: true, dedupeKey: true, category: true, source: true },
    });
    expect(tasks.map((t) => t.dedupeKey)).toEqual(
      expect.arrayContaining([
        `renewal:${membershipId}:7`,
        expect.stringMatching(`^dues:${membershipId}:`),
      ]),
    );
    expect(tasks.every((t) => t.source === 'SYSTEM')).toBe(true);
    duesTaskId = tasks.find((t) => t.category === 'PAYMENT_FOLLOW_UP')!.id;

    // Again, and twice at once: nothing new.
    const again = await as(org)(http().post('/action-center/generate')).expect(
      201,
    );
    expect(again.body.data.created).toBe(0);
    await Promise.all([
      generator.run(org.organizationId),
      generator.run(org.organizationId),
    ]);
    expect(
      await prisma.task.count({
        where: { organizationId: org.organizationId, memberId },
      }),
    ).toBe(tasks.length);
  });

  it('shows the receptionist the worklist and real counts', async () => {
    const list = await as(receptionist)(http().get('/tasks')).expect(200);
    expect(list.body.data.items.map((t: { id: string }) => t.id)).toContain(
      duesTaskId,
    );

    const summary = await as(receptionist)(
      http().get('/action-center/summary'),
    ).expect(200);
    expect(summary.body.data.due.payments).toBeGreaterThanOrEqual(1);
    expect(summary.body.data.due.renewals).toBeGreaterThanOrEqual(1);
    // Both are calls to the same member: the call queue counts them.
    expect(summary.body.data.due.calls).toBeGreaterThanOrEqual(2);
    expect(summary.body.data.tasks.total).toBeGreaterThanOrEqual(2);

    const queue = await as(receptionist)(
      http().get('/action-center/queue'),
    ).expect(200);
    const entry = queue.body.data.find(
      (q: { task: { id: string } }) => q.task.id === duesTaskId,
    );
    expect(entry.outstanding).toBe('50.00');
    expect(entry.reasons.join(' ')).toMatch(/outstanding/);
  });

  let callId: string;
  let promiseTaskId: string;

  it('logs the call: promise recorded, follow-up scheduled, dues task closed, note kept when AI is off', async () => {
    const res = await as(receptionist)(
      http()
        .post('/call-logs')
        .send({
          memberId,
          outcome: 'PAYMENT_PROMISED',
          reason: 'Outstanding balance',
          response: 'Salary will arrive tomorrow; I will pay ₹50.',
          amountDiscussed: 50,
          promisedPaymentDate: istDate(1),
          taskId: duesTaskId,
          completeTask: true,
        }),
    ).expect(201);
    callId = res.body.data.id;
    expect(res.body.data.phone).toBe('+919800000001');
    // No AI on this deployment: the note is saved, nothing is lost.
    expect(res.body.data.analysisStatus).toBe('FAILED');
    expect(res.body.data.analysisError).toMatch(/not configured/);

    const dues = await prisma.task.findUniqueOrThrow({
      where: { id: duesTaskId },
    });
    expect(dues.status).toBe('COMPLETED');
    expect(dues.completedByUserId).toBe(receptionist.userId);

    const promise = await prisma.paymentPromise.findFirstOrThrow({
      where: { callLogId: callId },
    });
    expect(Number(promise.amount)).toBe(50);
    expect(promise.status).toBe('OPEN');
    const promiseTask = await prisma.task.findFirstOrThrow({
      where: {
        organizationId: org.organizationId,
        dedupeKey: `promise:${promise.id}`,
      },
    });
    promiseTaskId = promiseTask.id;
    expect(promiseTask.assignedToUserId).toBe(receptionist.userId);
    expect(
      promiseTask.dueAt.toLocaleDateString('sv-SE', {
        timeZone: 'Asia/Kolkata',
      }),
    ).toBe(istDate(1));

    const history = await as(receptionist)(
      http().get('/call-logs').query({ memberId }),
    ).expect(200);
    expect(history.body.data.items[0].id).toBe(callId);

    const audit = await prisma.auditLog.findFirst({
      where: {
        organizationId: org.organizationId,
        resource: 'call_log',
        action: 'create',
      },
    });
    expect(audit?.actorUserId).toBe(receptionist.userId);
  });

  it('refuses "payment completed" without a payment the system recorded', async () => {
    await as(receptionist)(
      http().post('/call-logs').send({
        memberId,
        outcome: 'PAYMENT_COMPLETED',
        response: 'Says he paid',
      }),
    ).expect(400);
  });

  it('turns a validated AI analysis into proposals, and approval into one task', async () => {
    await prisma.callLog.update({
      where: { id: callId },
      data: { analysisStatus: 'PENDING' },
    });
    const spy = jest.spyOn(provider, 'chatCompletion').mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: JSON.stringify({
          summary: 'Will pay 50 tomorrow after salary.',
          intent: 'PAYMENT',
          sentiment: 'NEUTRAL',
          renewalLikelihood: 'UNKNOWN',
          objections: ['Waiting for salary'],
          followUpQuestions: [],
          commitments: [
            {
              type: 'PAYMENT',
              text: 'Pay ₹50 tomorrow',
              evidence: 'Salary will arrive tomorrow; I will pay ₹50.',
              amount: 50,
              date: istDate(1),
              time: null,
              dateAmbiguous: false,
            },
            {
              // Invented: not in the note, must be dropped.
              type: 'RENEWAL',
              text: 'Will renew for a year',
              evidence: 'I will renew for a whole year',
              amount: null,
              date: null,
            },
          ],
          recommendedAction: {
            kind: 'RENEWAL_FOLLOW_UP',
            title: 'Discuss renewal after payment',
            priority: 'MEDIUM',
            dueDate: 'next week',
            reason: 'Membership ends soon',
          },
        }),
      },
    });
    await analysis.run(org.organizationId, callId, true);
    spy.mockRestore();

    const call = await prisma.callLog.findUniqueOrThrow({
      where: { id: callId },
    });
    expect(call.analysisStatus).toBe('COMPLETED');
    const proposals = await as(receptionist)(
      http().get('/action-center/proposals'),
    ).expect(200);
    const mine = proposals.body.data.filter(
      (p: { callLogId: string }) => p.callLogId === callId,
    );
    expect(mine.map((p: { kind: string }) => p.kind).sort()).toEqual([
      'PAYMENT_PROMISE',
      'RENEWAL_FOLLOW_UP',
    ]);
    const renewal = mine.find(
      (p: { kind: string }) => p.kind === 'RENEWAL_FOLLOW_UP',
    );
    expect(renewal.explicit).toBe(false);
    expect(renewal.dueAtNeedsConfirmation).toBe(true);

    // An unclear date is never guessed.
    await as(receptionist)(
      http().post(`/action-center/proposals/${renewal.id}/approve`).send({}),
    ).expect(400);
    const approved = await as(receptionist)(
      http()
        .post(`/action-center/proposals/${renewal.id}/approve`)
        .send({
          dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          assignedToUserId: org.userId,
          title: 'Renewal chat',
        }),
    ).expect(201);
    expect(approved.body.data).toMatchObject({
      source: 'AI_SUGGESTION',
      title: 'Renewal chat',
      category: 'RENEWAL',
    });
    expect(approved.body.data.assignedToUser.id).toBe(org.userId);
    // Twice: one task.
    await as(receptionist)(
      http()
        .post(`/action-center/proposals/${renewal.id}/approve`)
        .send({ dueAt: new Date().toISOString() }),
    ).expect(409);

    const promiseProposal = mine.find(
      (p: { kind: string }) => p.kind === 'PAYMENT_PROMISE',
    );
    await as(receptionist)(
      http()
        .post(`/action-center/proposals/${promiseProposal.id}/reject`)
        .send({ reason: 'Already recorded' }),
    ).expect(201);
  });

  it('records a failed analysis without inventing anything, and allows a retry', async () => {
    await prisma.callLog.update({
      where: { id: callId },
      data: { analysisStatus: 'PENDING' },
    });
    const spy = jest.spyOn(provider, 'chatCompletion').mockResolvedValue({
      message: { role: 'assistant', content: 'I cannot help with that.' },
    });
    await analysis.run(org.organizationId, callId, true);
    spy.mockRestore();
    const call = await prisma.callLog.findUniqueOrThrow({
      where: { id: callId },
    });
    expect(call.analysisStatus).toBe('FAILED');
    expect(call.analysisError).toMatch(/could not be used/);
    // Decided proposals survive a failed re-run.
    expect(
      await prisma.actionProposal.count({
        where: { callLogId: callId, status: { not: 'PENDING' } },
      }),
    ).toBe(2);
    await as(receptionist)(http().post(`/call-logs/${callId}/analyze`)).expect(
      201,
    );
  });

  it('closes the promise, its task and the dues when a real payment lands', async () => {
    const payment = await as(org)(
      http()
        .post('/payments')
        .send({ memberId, membershipId, amount: 50, method: 'CASH' }),
    ).expect(201);
    const result = await generator.run(org.organizationId);
    expect(result.created).toBe(0);

    const promise = await prisma.paymentPromise.findFirstOrThrow({
      where: { callLogId: callId },
    });
    expect(promise.status).toBe('KEPT');
    expect(promise.resolvedPaymentId).toBe(payment.body.data.id);
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: promiseTaskId },
    });
    expect(task.status).toBe('COMPLETED');
    expect(task.completionNote).toMatch(/promise was kept/);
    const events = await prisma.taskEvent.findMany({
      where: { taskId: promiseTaskId },
    });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['CREATED', 'AUTO_RESOLVED']),
    );

    // Now a verified payment can back a "completed" call.
    await as(receptionist)(
      http().post('/call-logs').send({
        memberId,
        outcome: 'PAYMENT_COMPLETED',
        paymentId: payment.body.data.id,
      }),
    ).expect(201);
  });

  it('keeps tenants apart', async () => {
    await as(other)(http().get(`/tasks/${duesTaskId}`)).expect(404);
    await as(other)(
      http().patch(`/tasks/${duesTaskId}`).send({ status: 'CANCELLED' }),
    ).expect(404);
    await as(other)(
      http().post('/call-logs').send({ memberId, outcome: 'CONNECTED' }),
    ).expect(404);
    await as(other)(http().post(`/call-logs/${callId}/analyze`)).expect(404);
    const theirs = await as(other)(
      http().get('/tasks').query({ view: 'team' }),
    ).expect(200);
    expect(theirs.body.data.items).toHaveLength(0);
    const proposals = await as(other)(
      http().get('/action-center/proposals').query({ status: 'ALL' }),
    ).expect(200);
    expect(proposals.body.data).toHaveLength(0);
    // Assigning to another gym's user is refused.
    await as(org)(
      http().post('/tasks').send({
        title: 'x',
        dueAt: new Date().toISOString(),
        assignedToUserId: other.userId,
      }),
    ).expect(400);
  });

  it('applies the front-desk rules', async () => {
    const owners = await as(org)(
      http().post('/tasks').send({
        title: "Owner's task",
        dueAt: new Date().toISOString(),
        assignedToUserId: org.userId,
        memberId,
      }),
    ).expect(201);
    const id = owners.body.data.id;
    // Someone else's task: hands off.
    await as(receptionist)(
      http().patch(`/tasks/${id}`).send({ status: 'COMPLETED' }),
    ).expect(403);
    // An unassigned one can be taken, but not given to someone else.
    const open = await as(org)(
      http()
        .post('/tasks')
        .send({ title: 'Anyone', dueAt: new Date().toISOString() }),
    ).expect(201);
    await as(receptionist)(
      http()
        .patch(`/tasks/${open.body.data.id}`)
        .send({ assignedToUserId: org.userId }),
    ).expect(403);
    const taken = await as(receptionist)(
      http()
        .patch(`/tasks/${open.body.data.id}`)
        .send({ assignedToUserId: receptionist.userId }),
    ).expect(200);
    expect(taken.body.data.assignedToUser.id).toBe(receptionist.userId);
    // Escalation is open to anyone who can see the task.
    const esc = await as(receptionist)(
      http()
        .post(`/tasks/${open.body.data.id}/escalate`)
        .send({ reason: 'Member angry at the desk' }),
    ).expect(201);
    expect(esc.body.data.priority).toBe('URGENT');
    expect(esc.body.data.events.map((e: { type: string }) => e.type)).toContain(
      'ESCALATED',
    );
    // Trainers do not get the team worklist; settings are manager-only.
    await as(trainer)(http().get('/tasks')).expect(403);
    await as(receptionist)(
      http().patch('/action-center/settings').send({ inactiveDays: 30 }),
    ).expect(403);
    await as(receptionist)(http().post('/action-center/generate')).expect(403);
  });

  it('rejects stale edits instead of overwriting them', async () => {
    const created = await as(org)(
      http()
        .post('/tasks')
        .send({ title: 'Race', dueAt: new Date().toISOString() }),
    ).expect(201);
    const id = created.body.data.id;
    await Promise.all([
      as(org)(http().patch(`/tasks/${id}`).send({ priority: 'HIGH' })),
      as(org)(http().patch(`/tasks/${id}`).send({ priority: 'LOW' })),
    ]);
    const events = await prisma.taskEvent.count({
      where: { taskId: id, type: 'UPDATED' },
    });
    expect(events).toBeGreaterThanOrEqual(1);
    expect(events).toBeLessThanOrEqual(2);
  });

  it('cancels, never deletes, tasks whose member is removed', async () => {
    const m = await as(org)(
      http().post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Gone',
        lastName: 'Member',
      }),
    ).expect(201);
    const t = await as(org)(
      http().post('/tasks').send({
        title: 'Call Gone',
        dueAt: new Date().toISOString(),
        memberId: m.body.data.id,
      }),
    ).expect(201);
    // A generated task about them, then the member is soft-deleted.
    await prisma.task.update({
      where: { id: t.body.data.id },
      data: {
        dedupeKey: `test:${t.body.data.id}`,
        sourceType: 'MEMBER',
        sourceId: m.body.data.id,
      },
    });
    await prisma.member.update({
      where: { id: m.body.data.id },
      data: { deletedAt: new Date() },
    });
    await generator.run(org.organizationId);
    const after = await prisma.task.findUniqueOrThrow({
      where: { id: t.body.data.id },
    });
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelReason).toMatch(/member was removed/);
  });

  it('validates dates and amounts on the way in', async () => {
    await as(receptionist)(
      http()
        .post('/call-logs')
        .send({
          memberId,
          outcome: 'PAYMENT_PROMISED',
          amountDiscussed: 100,
          promisedPaymentDate: istDate(-2),
        }),
    ).expect(400);
    await as(receptionist)(
      http()
        .post('/call-logs')
        .send({
          memberId,
          outcome: 'CONNECTED',
          calledAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
    ).expect(400);
    await as(receptionist)(
      http()
        .post('/call-logs')
        .send({ memberId, outcome: 'CONNECTED', amountDiscussed: -5 }),
    ).expect(400);
    await as(receptionist)(
      http().post('/call-logs').send({ outcome: 'CONNECTED' }),
    ).expect(400);
  });

  it('lists assignable staff for the front desk, never members or other gyms', async () => {
    const res = await as(receptionist)(
      http().get('/action-center/staff'),
    ).expect(200);
    const ids = res.body.data.map((u: { id: string }) => u.id);
    expect(ids).toEqual(
      expect.arrayContaining([org.userId, receptionist.userId]),
    );
    expect(ids).not.toContain(other.userId);
  });

  it('produces the end-of-day report and briefing from the same records', async () => {
    const report = await as(org)(http().get('/action-center/report')).expect(
      200,
    );
    expect(report.body.data.calls.total).toBeGreaterThanOrEqual(2);
    expect(
      report.body.data.calls.byOutcome.PAYMENT_PROMISED,
    ).toBeGreaterThanOrEqual(1);
    expect(report.body.data.payments.promisesKept).toBeGreaterThanOrEqual(1);
    const briefing = await as(org)(
      http().get('/action-center/briefing'),
    ).expect(200);
    expect(typeof briefing.body.data.headline).toBe('string');
  });
});
