// MUST stay first -- see the helper.
import { restoreWhatsappWebTestEnv } from './utils/whatsapp-web-test-env';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { WA_SOCKET_FACTORY } from '../src/whatsapp-web/whatsapp-web.types';
import { eventually, fakeWhatsapp } from './utils/fake-whatsapp';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

const DAY = 24 * 60 * 60 * 1000;

/**
 * A member replies to the gym's WhatsApp -- as the welcome message invites
 * them to -- and gets an answer from the gym's own data, on the gym's own
 * number, without waiting for staff.
 */
describe('WhatsApp auto-replies (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gym: RegisteredAccount;
  const { factory, socketFor } = fakeWhatsapp();

  const server = () => app.getHttpServer();
  const as = (token: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      request(server()).patch(url).set('Authorization', `Bearer ${token}`),
  });

  let phoneSeq = 0;
  /** A fresh 10-digit Indian mobile, and the digits WhatsApp shows for it. */
  function newPhone() {
    phoneSeq += 1;
    const local = `97${String(Date.now()).slice(-6)}${String(phoneSeq).padStart(2, '0')}`;
    return { local, digits: `91${local}` };
  }

  /** The member (or stranger) sends a text to the gym's number. */
  function says(digits: string, text: string) {
    socketFor(gym.organizationId).emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: `${digits}@s.whatsapp.net`, fromMe: false },
          message: { conversation: text },
        },
      ],
    });
  }

  const repliesTo = (digits: string) =>
    socketFor(gym.organizationId).sent.filter((m) => m.jid.startsWith(digits));

  /** Waits for the reply to `text`, and returns it. */
  async function ask(digits: string, text: string): Promise<string> {
    const before = repliesTo(digits).length;
    says(digits, text);
    const sent = await eventually(
      async () => repliesTo(digits),
      (replies) => replies.length > before,
    );
    return sent[sent.length - 1].text;
  }

  /** Sends `text` and shows that no answer comes. */
  async function unanswered(digits: string, text: string) {
    const before = repliesTo(digits).length;
    const inboxBefore = await prisma.inboundMessage.count({
      where: { organizationId: gym.organizationId },
    });
    says(digits, text);
    // Filed like every message...
    await eventually(
      () =>
        prisma.inboundMessage.count({
          where: { organizationId: gym.organizationId },
        }),
      (n) => n > inboxBefore,
    );
    // ...and given time an answer would have taken.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(repliesTo(digits)).toHaveLength(before);
  }

  async function member(firstName = 'Asha') {
    const phone = newPhone();
    const res = await as(gym.accessToken)
      .post('/members')
      .send({
        primaryBranchId: gym.branchId,
        firstName,
        lastName: 'Verma',
        phone: phone.local,
      })
      .expect(201);
    // Every new member is welcomed on WhatsApp first; let that land so it
    // isn't mistaken for an answer.
    await eventually(
      async () => repliesTo(phone.digits),
      (sent) => sent.some((m) => m.text.includes('welcome to')),
    );
    return { id: res.body.data.id as string, ...phone };
  }

  beforeAll(async () => {
    app = (
      await createTestApp((b) =>
        b.overrideProvider(WA_SOCKET_FACTORY).useValue(factory),
      )
    ).app;
    prisma = app.get(PrismaService);
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Auto Reply Fitness',
        email: `auto-reply-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    const token = res.body.data.accessToken;
    const branches = await as(token).get('/branches').expect(200);
    gym = {
      accessToken: token,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
    await prisma.organization.update({
      where: { id: gym.organizationId },
      data: { currency: 'INR', timezone: 'Asia/Kolkata' },
    });
    // Set the way the Gym profile page does: address, directions and
    // morning/evening hours six days a week.
    await as(gym.accessToken)
      .patch(`/branches/${gym.branchId}`)
      .send({
        addressLine1: '12 MG Road',
        city: 'Pune',
        phone: '020 5555 1234',
        mapsUrl: 'https://maps.app.goo.gl/abc123',
        openingHours: [0, 1, 2, 3, 4, 5].flatMap((day) => [
          { day, open: '16:00', close: '22:00' },
          { day, open: '05:00', close: '11:00' },
        ]),
      })
      .expect(200);

    await as(gym.accessToken)
      .post('/whatsapp-web/connect')
      .send({ acceptRisk: true })
      .expect(201);
    const socket = socketFor(gym.organizationId);
    socket.user = { id: '919800000019@s.whatsapp.net' };
    socket.emit('connection.update', { connection: 'open' });
    await eventually(
      () =>
        prisma.whatsappWebSession.findUniqueOrThrow({
          where: { organizationId: gym.organizationId },
        }),
      (s) => s.status === 'CONNECTED',
    );
    const settings = await as(gym.accessToken)
      .patch('/whatsapp-web/settings')
      .send({ useForSending: true })
      .expect(200);
    // On unless the gym turns it off.
    expect(settings.body.data.autoReply).toBe(true);

    await as(gym.accessToken)
      .post('/membership-plans')
      .send({ name: 'Monthly', durationDays: 30, price: 1500 })
      .expect(201);
    await as(gym.accessToken)
      .post('/membership-plans')
      .send({ name: 'Annual', durationDays: 365, price: 12000 })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    restoreWhatsappWebTestEnv();
  });

  it('answers "Memberships" with the plans and prices', async () => {
    const m = await member();
    const reply = await ask(m.digits, 'Memberships');
    expect(reply).toContain('Auto Reply Fitness membership plans');
    expect(reply).toContain('Monthly – ₹1,500 for 1 month');
    expect(reply).toContain('Annual – ₹12,000 for 1 year');

    // Logged against the member, like any message the gym sends.
    const log = await prisma.messageLog.findFirstOrThrow({
      where: { memberId: m.id, templateKey: 'auto_reply.plans' },
    });
    expect(log.channel).toBe('WHATSAPP');
  });

  it('does not send the same answer twice in a row', async () => {
    const m = await member();
    await ask(m.digits, 'Membership');
    await unanswered(m.digits, 'Memberships');
  });

  it('tells a member their own membership, and where to renew', async () => {
    const m = await member('Ravi');
    const plan = await prisma.membershipPlan.findFirstOrThrow({
      where: { organizationId: gym.organizationId, name: 'Monthly' },
    });
    await as(gym.accessToken)
      .post('/memberships')
      .send({ memberId: m.id, membershipPlanId: plan.id })
      .expect(201);
    const reply = await ask(m.digits, 'my plan kab tak hai?');
    expect(reply).toMatch(
      /^Hi Ravi, your Monthly membership is active until \d{1,2} \w{3} \d{4} \(\d+ days left\)\./,
    );
    expect(reply).toContain('/portal/renew');
  });

  it("says so when the number isn't a member's", async () => {
    const stranger = newPhone();
    const reply = await ask(stranger.digits, 'renewal');
    expect(reply).toContain(
      "We couldn't find a Auto Reply Fitness membership for this number",
    );
  });

  it("lists the week's classes in the gym's time", async () => {
    const program = await prisma.classProgram.create({
      data: {
        organizationId: gym.organizationId,
        branchId: gym.branchId,
        name: 'Morning Yoga',
        capacity: 20,
        durationMinutes: 60,
      },
    });
    // Tomorrow at 07:00 in India.
    const start = new Date(Date.now() + DAY);
    start.setUTCHours(1, 30, 0, 0);
    await prisma.classSession.create({
      data: {
        organizationId: gym.organizationId,
        branchId: gym.branchId,
        classProgramId: program.id,
        startTime: start,
        endTime: new Date(start.getTime() + 60 * 60 * 1000),
      },
    });
    const m = await member();
    const reply = await ask(m.digits, 'class timings?');
    expect(reply).toContain('Auto Reply Fitness classes this week');
    expect(reply).toMatch(/7:00 am – Morning Yoga/);
  });

  it('gives the address and phone', async () => {
    const m = await member();
    const reply = await ask(m.digits, 'gym kahan hai');
    expect(reply).toContain('12 MG Road, Pune · 020 5555 1234');
    expect(reply).toContain('Directions: https://maps.app.goo.gl/abc123');
  });

  it('gives the opening hours, and "class timings" still gives classes', async () => {
    const m = await member();
    const reply = await ask(m.digits, 'gym timing kya hai?');
    expect(reply).toBe(
      [
        '*Auto Reply Fitness timings*',
        'Mon–Sat: 5:00 am – 11:00 am, 4:00 pm – 10:00 pm',
        'Sun: Closed',
      ].join('\n'),
    );
  });

  it('greets with the menu', async () => {
    const m = await member('Neha');
    const reply = await ask(m.digits, 'Hi');
    expect(reply).toContain('Hi Neha! Welcome to Auto Reply Fitness.');
    expect(reply).toContain('*PLANS*');
  });

  it('says the team will reply to a question it cannot answer -- once', async () => {
    const m = await member();
    const reply = await ask(m.digits, 'Can I bring a friend on Sunday?');
    expect(reply).toContain('team will reply soon');
    // An hour later, a new question still isn't answered with the same
    // "we'll reply" -- that is said once in 12 hours.
    await prisma.messageLog.updateMany({
      where: { memberId: m.id, templateKey: 'auto_reply.unknown' },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    await unanswered(m.digits, 'Also, is there parking?');
  });

  it('stays quiet on "thanks"', async () => {
    const m = await member();
    await unanswered(m.digits, 'Thanks!');
  });

  it('leaves questions to staff while they are chatting with the member', async () => {
    const m = await member();
    await as(gym.accessToken)
      .post(`/members/${m.id}/communications/send`)
      .send({
        channel: 'WHATSAPP',
        customBody: 'Hi, this is Priya from the desk.',
      })
      .expect(201);
    await eventually(
      async () => repliesTo(m.digits),
      (sent) => sent.some((x) => x.text.includes('Priya')),
    );
    await unanswered(m.digits, 'Can I bring a friend on Sunday?');
    // A keyword still gets its instant answer.
    expect(await ask(m.digits, 'plans')).toContain('membership plans');
  });

  it('stops after six answers an hour to one number', async () => {
    const m = await member();
    // Six different answers over the last hour, none of them just now.
    await prisma.messageLog.createMany({
      data: ['menu', 'classes', 'contact', 'my_plan', 'unknown', 'menu'].map(
        (intent, n) => ({
          organizationId: gym.organizationId,
          channel: 'WHATSAPP' as const,
          category: 'TRANSACTIONAL' as const,
          templateKey: `auto_reply.${intent}`,
          recipient: m.digits,
          memberId: m.id,
          status: 'SENT' as const,
          createdAt: new Date(Date.now() - (10 + n * 5) * 60 * 1000),
        }),
      ),
    });
    await unanswered(m.digits, 'plans');
  });

  it('answers nothing once the gym turns auto-replies off', async () => {
    const off = await as(gym.accessToken)
      .patch('/whatsapp-web/settings')
      .send({ autoReply: false })
      .expect(200);
    expect(off.body.data.autoReply).toBe(false);
    const m = await member();
    await unanswered(m.digits, 'Memberships');
    await as(gym.accessToken)
      .patch('/whatsapp-web/settings')
      .send({ autoReply: true })
      .expect(200);
  });
});
