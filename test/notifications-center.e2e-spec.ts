import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P0-2 (BACKLOG.md): first e2e coverage for the in-app notification
 * centre (src/notifications/ minus the welcome-email queue, which
 * test/notifications-queue.e2e-spec.ts already covers).
 *
 * The behaviour worth pinning down is the fan-out path end to end:
 * POST /members -> MemberCreated domain event -> DomainNotificationListener
 * -> notifyOrganization -> one Notification row per ACTIVE org user, with
 * per-user, per-category opt-out respected. Domain events are emitted
 * fire-and-forget, so reads poll rather than assuming the row exists by the
 * time the HTTP response returns.
 */
describe('Notification centre (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let ownerUserId: string;
  let staffToken: string;
  let staffUserId: string;
  let branchId: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);
  const asStaff = (req: request.Test) => authed(staffToken)(req);

  /** Polls until `probe` returns a value, so a fire-and-forget domain
   * event has a bounded window to land without an arbitrary sleep. */
  async function waitFor<T>(
    probe: () => Promise<T | undefined>,
    timeoutMs = 5000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the expected notification');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const createMember = (firstName: string) =>
    asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName,
        lastName: 'Notify',
      }),
    ).expect(201);

  const countFor = (userId: string, type: string) =>
    prisma.notification.count({ where: { userId, type } });

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Notification Test Gym',
        email: `notifications-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Notify',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;
    ownerUserId = registered.body.data.user.id;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    const invited = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `notifications-staff-${Date.now()}@example.com`,
          firstName: 'Second',
          lastName: 'Recipient',
          primaryBranchId: branchId,
          roleKey: 'RECEPTIONIST',
          roleBranchId: branchId,
        }),
    ).expect(201);
    staffUserId = invited.body.data.id;
    // notifyOrganization only fans out to ACTIVE users, so the invite has
    // to be accepted (simulated here) before it can receive anything.
    await prisma.user.update({
      where: { id: staffUserId },
      data: { status: 'ACTIVE' },
    });
    staffToken = app.get(TokensService).signAccessToken(staffUserId);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('fans a member-created event out to every active user in the org', async () => {
    await createMember('Nina');

    const ownerNotification = await waitFor(async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/notifications'),
      ).expect(200);
      return res.body.data.items.find(
        (n: { type: string }) => n.type === 'MEMBER_CREATED',
      );
    });
    expect(ownerNotification.title).toBe('New member added');
    expect(ownerNotification.body).toContain('Nina');
    expect(ownerNotification.actionUrl).toMatch(/^\/members\//);
    expect(ownerNotification.readAt).toBeNull();

    // The same event reaches the second active user, as its own row.
    await waitFor(async () => {
      const res = await asStaff(
        request(app.getHttpServer()).get('/notifications'),
      ).expect(200);
      return res.body.data.items.find(
        (n: { type: string }) => n.type === 'MEMBER_CREATED',
      );
    });
  });

  it('reports an unread count and can filter to unread only', async () => {
    const res = await asOwner(
      request(app.getHttpServer())
        .get('/notifications')
        .query({ unreadOnly: 'true' }),
    ).expect(200);
    expect(res.body.data.unreadCount).toBeGreaterThan(0);
    expect(
      res.body.data.items.every(
        (n: { readAt: string | null }) => n.readAt === null,
      ),
    ).toBe(true);
  });

  it('marks a single notification read, idempotently', async () => {
    const list = await asOwner(
      request(app.getHttpServer()).get('/notifications'),
    ).expect(200);
    const target = list.body.data.items[0];
    const unreadBefore = list.body.data.unreadCount;

    const first = await asOwner(
      request(app.getHttpServer()).patch(`/notifications/${target.id}/read`),
    ).expect(200);
    expect(first.body.data.readAt).toBeTruthy();

    // Second call is a no-op rather than an error or a moved timestamp.
    const second = await asOwner(
      request(app.getHttpServer()).patch(`/notifications/${target.id}/read`),
    ).expect(200);
    expect(second.body.data.id).toBe(target.id);

    const after = await asOwner(
      request(app.getHttpServer()).get('/notifications'),
    ).expect(200);
    expect(after.body.data.unreadCount).toBe(unreadBefore - 1);
  });

  it("refuses to mark another user's notification read", async () => {
    const staffNotification = await prisma.notification.findFirstOrThrow({
      where: { userId: staffUserId },
      select: { id: true },
    });

    await asOwner(
      request(app.getHttpServer()).patch(
        `/notifications/${staffNotification.id}/read`,
      ),
    ).expect(404);

    const stillUnread = await prisma.notification.findUniqueOrThrow({
      where: { id: staffNotification.id },
      select: { readAt: true },
    });
    expect(stillUnread.readAt).toBeNull();
  });

  it('returns 404 for a notification that does not exist', async () => {
    await asOwner(
      request(app.getHttpServer()).patch(
        '/notifications/00000000-0000-4000-8000-000000000000/read',
      ),
    ).expect(404);
  });

  // Preferences are keyed by *category*, not by notification `type`:
  // MEMBER_CREATED notifications are filed under the MEMBERS category,
  // so opting out of "members" is what silences them.
  describe('preferences', () => {
    it('upserts a preference, normalizing the category to upper case', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .patch('/notifications/preferences/members')
          .send({ inApp: false, email: true }),
      ).expect(200);
      expect(res.body.data.category).toBe('MEMBERS');
      expect(res.body.data.inApp).toBe(false);
      expect(res.body.data.email).toBe(true);

      const list = await asOwner(
        request(app.getHttpServer()).get('/notifications/preferences'),
      ).expect(200);
      const pref = list.body.data.find(
        (p: { category: string }) => p.category === 'MEMBERS',
      );
      expect(pref.inApp).toBe(false);
    });

    it('rejects a string in place of a boolean instead of coercing it', async () => {
      // Regression test for a real bug found writing this suite: the global
      // `enableImplicitConversion` turns *any* non-empty string into `true`,
      // so `{"inApp": "false"}` silently opted the user back IN. Both the
      // obviously-wrong value and the dangerous "false" must 400.
      for (const value of ['nope', 'false', '0']) {
        await asOwner(
          request(app.getHttpServer())
            .patch('/notifications/preferences/members')
            .send({ inApp: value }),
        ).expect(400);
      }

      // ...and the opt-out recorded earlier is still intact afterwards.
      const list = await asOwner(
        request(app.getHttpServer()).get('/notifications/preferences'),
      ).expect(200);
      const pref = list.body.data.find(
        (p: { category: string }) => p.category === 'MEMBERS',
      );
      expect(pref.inApp).toBe(false);
    });

    it('refuses a category nothing ever notifies on (B-P0-11)', async () => {
      // The route used to upsert whatever string arrived in the path. A
      // preference stored under BILLING is not wrong-looking -- it is
      // inert: `notifyOrganization` looks preferences up by the exact
      // category it publishes under, and nothing publishes under BILLING,
      // so the user watches their opt-out save and keeps being notified.
      for (const bogus of [
        'BILLING',
        'member',
        'MEMBERS_2',
        'PAYMENT_RECORDED',
      ]) {
        const res = await asOwner(
          request(app.getHttpServer())
            .patch(`/notifications/preferences/${bogus}`)
            .send({ inApp: false }),
        ).expect(400);
        expect(res.body.error.message).toContain(
          'Unknown notification category',
        );
      }

      // PAYMENT_RECORDED above is the sharp one: it is a real notification
      // *type*, and the old `category ?? type` fallback made types and
      // categories look interchangeable when they are not.
      const stored = await prisma.notificationPreference.findMany({
        where: { userId: ownerUserId },
        select: { category: true },
      });
      expect(stored.map((p) => p.category)).not.toContain('BILLING');
      expect(stored.map((p) => p.category)).not.toContain('PAYMENT_RECORDED');
    });

    it('serves the catalog the settings screen renders from', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/notifications/categories'),
      ).expect(200);
      const keys = res.body.data.map((c: { key: string }) => c.key);
      expect(keys).toEqual([
        'MEMBERS',
        'MEMBERSHIPS',
        'ATTENDANCE',
        'PAYMENTS',
        'CRM',
        'WORKOUT',
        'DIET',
        'INVENTORY',
        'PT',
        'WHATSAPP',
      ]);
      for (const category of res.body.data) {
        expect(typeof category.label).toBe('string');
        expect(category.label.length).toBeGreaterThan(0);
        expect(typeof category.description).toBe('string');
      }
    });

    it('accepts every category the catalog advertises', async () => {
      // The catalog and the validator must agree in both directions: the
      // test above proves the unknown ones are refused, this one proves
      // the advertised ones are not.
      const catalog = await asOwner(
        request(app.getHttpServer()).get('/notifications/categories'),
      ).expect(200);

      for (const { key } of catalog.body.data as { key: string }[]) {
        await asOwner(
          request(app.getHttpServer())
            .patch(`/notifications/preferences/${key}`)
            .send({ email: true }),
        ).expect(200);
      }

      // Restore the MEMBERS opt-out the earlier cases set up and the two
      // fan-out cases below depend on -- the loop only touched `email`.
      const list = await asOwner(
        request(app.getHttpServer()).get('/notifications/preferences'),
      ).expect(200);
      const members = list.body.data.find(
        (p: { category: string }) => p.category === 'MEMBERS',
      );
      expect(members.inApp).toBe(false);
    });

    it('stops in-app fan-out for the opted-out user only', async () => {
      const ownerBefore = await countFor(ownerUserId, 'MEMBER_CREATED');
      const staffBefore = await countFor(staffUserId, 'MEMBER_CREATED');

      await createMember('Omar');

      // Wait on the still-opted-in user so the event is known to have been
      // processed before asserting the opted-out user got nothing --
      // otherwise the negative assertion could pass simply by racing ahead.
      await waitFor(async () => {
        const count = await countFor(staffUserId, 'MEMBER_CREATED');
        return count > staffBefore ? count : undefined;
      });

      expect(await countFor(ownerUserId, 'MEMBER_CREATED')).toBe(ownerBefore);
    });

    it('resumes fan-out once the preference is turned back on', async () => {
      await asOwner(
        request(app.getHttpServer())
          .patch('/notifications/preferences/members')
          .send({ inApp: true }),
      ).expect(200);

      const ownerBefore = await countFor(ownerUserId, 'MEMBER_CREATED');
      await createMember('Priya');

      const after = await waitFor(async () => {
        const count = await countFor(ownerUserId, 'MEMBER_CREATED');
        return count > ownerBefore ? count : undefined;
      });
      expect(after).toBe(ownerBefore + 1);
    });
  });

  it('marks every remaining notification read', async () => {
    const res = await asOwner(
      request(app.getHttpServer()).patch('/notifications/read-all'),
    ).expect(200);
    expect(res.body.data.updated).toBeGreaterThan(0);

    const after = await asOwner(
      request(app.getHttpServer()).get('/notifications'),
    ).expect(200);
    expect(after.body.data.unreadCount).toBe(0);

    // The other user's unread notifications are untouched by read-all.
    const staffUnread = await prisma.notification.count({
      where: { userId: staffUserId, readAt: null },
    });
    expect(staffUnread).toBeGreaterThan(0);
  });
});
