import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokensService } from '../src/auth/tokens.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P0-5 (BACKLOG.md): one table of record for device check-in.
 *
 * The kiosk and the biometric turnstile used to be two unreconciled
 * systems. The kiosk wrote only to a `kiosk_events` table that nothing
 * read, so a member who checked in at a kiosk appeared in no attendance
 * list, no report, no live turnstile view, and triggered no
 * `AttendanceRecorded` notification. The turnstile's controller was
 * declared in no module at all, so its endpoint did not exist.
 *
 * What is pinned down here is that a kiosk check-in is now an ordinary
 * attendance record, indistinguishable to every reader from one typed in
 * at the front desk except for the device that made it:
 *  - an allowed kiosk check-in appears in GET /attendance and in the live
 *    view, carrying method KIOSK and the device id;
 *  - a *denied* one is recorded too, with its reason -- the front desk
 *    needs to know someone was turned away;
 *  - an unknown member is a clean denial, not the 500 the old code's
 *    foreign-key violation produced;
 *  - a bad device key is a 401, and the branch check still holds;
 *  - `/devices/check-in` exists at all.
 */
describe('Kiosk and device check-in reconciliation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let ownerToken: string;
  let organizationId: string;
  let branchId: string;
  let deviceId: string;
  let deviceKey: string;
  let eligibleMemberId: string;
  let ineligibleMemberId: string;
  let trainerToken: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);

  // The kiosk endpoint rate-limits per client key, so every call gets a
  // distinct forwarded address or later tests inherit earlier hits.
  let fwd = 0;
  const fromIp = (req: request.Test) =>
    req.set('X-Forwarded-For', `10.1.0.${++fwd % 254}-${Date.now()}`);

  const checkIn = (body: Record<string, unknown>) =>
    fromIp(request(app.getHttpServer()).post('/kiosk/check-in').send(body));

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Kiosk Test Gym',
        email: `kiosk-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Kira',
        lastName: 'Owner',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;
    organizationId = registered.body.data.organization.id;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    const plan = await asOwner(
      request(app.getHttpServer()).post('/membership-plans').send({
        name: 'Kiosk Plan',
        price: 1000,
        durationDays: 30,
      }),
    ).expect(201);

    const eligible = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Eli',
        lastName: 'Gible',
      }),
    ).expect(201);
    eligibleMemberId = eligible.body.data.id;
    await asOwner(
      request(app.getHttpServer())
        .post('/memberships')
        .send({
          memberId: eligibleMemberId,
          membershipPlanId: plan.body.data.id,
          startDate: new Date().toISOString().slice(0, 10),
        }),
    ).expect(201);

    const ineligible = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Ina',
        lastName: 'Eligible',
      }),
    ).expect(201);
    ineligibleMemberId = ineligible.body.data.id;

    const trainer = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `kiosk-trainer-${Date.now()}@example.com`,
          firstName: 'Tam',
          lastName: 'Trainer',
          primaryBranchId: branchId,
          roleKey: 'TRAINER',
          isTrainer: true,
        }),
    ).expect(201);
    await prisma.user.update({
      where: { id: trainer.body.data.id },
      data: { status: 'ACTIVE' },
    });
    trainerToken = app.get(TokensService).signAccessToken(trainer.body.data.id);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe('device registration', () => {
    it('returns the key exactly once and stores only its hash', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .post('/devices')
          .send({ branchId, name: 'Front Desk Tablet' }),
      ).expect(201);

      deviceKey = res.body.data.key;
      deviceId = res.body.data.id;
      expect(typeof deviceKey).toBe('string');
      expect(res.body.data.name).toBe('Front Desk Tablet');

      const stored = await prisma.kioskDevice.findUnique({
        where: { id: deviceId },
        select: { keyHash: true },
      });
      // The plaintext key must not be recoverable from the row.
      expect(stored?.keyHash).not.toBe(deviceKey);
    });

    it('refuses a branch outside the caller organization', async () => {
      await asOwner(
        request(app.getHttpServer()).post('/devices').send({
          branchId: '00000000-0000-0000-0000-000000000000',
          name: 'X',
        }),
      ).expect(404);
    });

    it('denies a caller without kiosk.manage', async () => {
      await authed(trainerToken)(
        request(app.getHttpServer())
          .post('/devices')
          .send({ branchId, name: 'Nope' }),
      ).expect(403);
    });
  });

  describe('an allowed kiosk check-in', () => {
    let attendanceId: string;

    it('answers 200 with the gate decision', async () => {
      // 200, not 201: an unattended device treats a non-200 as a failure
      // worth retrying, which is why /devices/check-in already answers 200.
      const res = await checkIn({
        deviceKey,
        memberId: eligibleMemberId,
      }).expect(200);

      expect(res.body.data.allowed).toBe(true);
      expect(res.body.data.member.id).toBe(eligibleMemberId);
      attendanceId = res.body.data.attendanceId;
      expect(attendanceId).toBeTruthy();
    });

    it('writes a real attendance row carrying the method and the device', async () => {
      // The heart of B-P0-5. Before it, this row did not exist at all.
      const row = await prisma.attendance.findUnique({
        where: { id: attendanceId },
        select: {
          organizationId: true,
          branchId: true,
          memberId: true,
          method: true,
          deviceId: true,
          deniedReason: true,
        },
      });
      expect(row).toEqual({
        organizationId,
        branchId,
        memberId: eligibleMemberId,
        method: 'KIOSK',
        deviceId,
        deniedReason: null,
      });
    });

    it('shows up in the attendance list like any other check-in', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .get('/attendance')
          .query({ memberId: eligibleMemberId }),
      ).expect(200);
      expect(
        res.body.data.items.some(
          (row: { id: string }) => row.id === attendanceId,
        ),
      ).toBe(true);
    });

    it('shows up in the live turnstile view', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/attendance/live'),
      ).expect(200);
      const inside = JSON.stringify(res.body.data);
      expect(inside).toContain(eligibleMemberId);
    });
  });

  describe('a denied kiosk check-in', () => {
    it('is still recorded, with the gate reason', async () => {
      const res = await checkIn({
        deviceKey,
        memberId: ineligibleMemberId,
      }).expect(200);
      expect(res.body.data.allowed).toBe(false);
      expect(res.body.data.reason).toMatch(/membership|invoice/i);

      // A member turned away at the door is information the front desk
      // needs; the old kiosk path left no trace of it in attendance.
      const row = await prisma.attendance.findUnique({
        where: { id: res.body.data.attendanceId },
        select: { method: true, deviceId: true, deniedReason: true },
      });
      expect(row?.method).toBe('KIOSK');
      expect(row?.deviceId).toBe(deviceId);
      expect(row?.deniedReason).toBe(res.body.data.reason);
    });

    it('denies an unknown member cleanly instead of failing', async () => {
      // The old implementation logged a kiosk_events row with the
      // unverified member id. That column is a foreign key, so an unknown
      // id raised a constraint violation and the caller got a 500 rather
      // than a decision it could display.
      const res = await checkIn({
        deviceKey,
        memberId: '00000000-0000-0000-0000-000000000000',
      }).expect(200);
      expect(res.body.data.allowed).toBe(false);
      expect(res.body.data.reason).toBe('member not found');
    });

    it('denies a member belonging to another branch', async () => {
      const other = await asOwner(
        request(app.getHttpServer())
          .post('/branches')
          .send({ name: 'Other', slug: `other-${Date.now()}` }),
      ).expect(201);
      const otherMember = await asOwner(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: other.body.data.id,
          firstName: 'Odd',
          lastName: 'Branch',
        }),
      ).expect(201);

      const res = await checkIn({
        deviceKey,
        memberId: otherMember.body.data.id,
      }).expect(200);
      expect(res.body.data.allowed).toBe(false);
      expect(res.body.data.reason).toMatch(/different branch/);
    });
  });

  describe('the device key is the credential', () => {
    it('rejects an unknown key with 401', async () => {
      await checkIn({
        deviceKey: 'not-a-real-key',
        memberId: eligibleMemberId,
      }).expect(401);
    });

    it('rejects a deactivated device', async () => {
      const retired = await asOwner(
        request(app.getHttpServer())
          .post('/devices')
          .send({ branchId, name: 'Retired Tablet' }),
      ).expect(201);
      await prisma.kioskDevice.update({
        where: { id: retired.body.data.id },
        data: { active: false },
      });

      await checkIn({
        deviceKey: retired.body.data.key,
        memberId: eligibleMemberId,
      }).expect(401);
    });

    it('keeps the attendance history of a retired device', async () => {
      // SetNull, not Cascade: decommissioning a kiosk must not erase the
      // check-ins it recorded.
      const before = await prisma.attendance.count({
        where: { deviceId },
      });
      expect(before).toBeGreaterThan(0);

      await prisma.kioskDevice.delete({ where: { id: deviceId } });

      const orphaned = await prisma.attendance.count({
        where: { organizationId, method: 'KIOSK', deviceId: null },
      });
      expect(orphaned).toBeGreaterThanOrEqual(before);
    });
  });

  describe('the biometric turnstile endpoint', () => {
    it('exists, rather than 404ing because its controller was never registered', async () => {
      // DevicesController was declared in no module, so this route did not
      // exist at runtime even though the branches UI hands out the key it
      // consumes. An invalid key must be a 401 -- anything but a 404.
      await request(app.getHttpServer())
        .post('/devices/check-in')
        .send({ deviceKey: 'nope', externalUserId: 'x' })
        .expect(401);
    });

    /**
     * B-P0-13. The turnstile used to authenticate against
     * `Branch.deviceKey`: one plaintext secret shared by every scanner on
     * the branch, unhashed in the row, with no way to rotate or revoke a
     * single device -- and, as it turned out, no write path anywhere in
     * the API, so the column was always NULL and this route could never
     * authenticate at all. It now resolves the same hashed, per-device
     * registry the kiosk uses.
     */
    describe('authenticates against the device registry (B-P0-13)', () => {
      let turnstileKey: string;
      let turnstileId: string;
      let externalUserId: string;

      beforeAll(async () => {
        const registered = await asOwner(
          request(app.getHttpServer())
            .post('/devices')
            .send({ branchId, name: 'Main Turnstile', kind: 'BIOMETRIC' }),
        ).expect(201);
        turnstileKey = registered.body.data.key;
        turnstileId = registered.body.data.id;
        expect(registered.body.data.kind).toBe('BIOMETRIC');

        const stored = await prisma.kioskDevice.findUniqueOrThrow({
          where: { id: turnstileId },
          select: { keyHash: true },
        });
        expect(stored.keyHash).not.toBe(turnstileKey);

        // Enrolled through the API rather than inserted directly: since
        // B-P1-8 there is a real enrolment surface, and a check-in test
        // that seeds `device_maps` by hand would keep passing if that
        // surface broke.
        externalUserId = `ext-${Date.now()}`;
        await asOwner(
          request(app.getHttpServer())
            .post('/attendance/enrolments')
            .send({ branchId, memberId: eligibleMemberId, externalUserId }),
        ).expect(201);
      });

      it('admits a member through a registered turnstile', async () => {
        const res = await request(app.getHttpServer())
          .post('/devices/check-in')
          .send({ deviceKey: turnstileKey, externalUserId })
          .expect(200);
        expect(res.body.data.allowed).toBe(true);
        expect(res.body.data.method).toBe('BIOMETRIC');
        // Attribution the shared branch key could not provide: with one
        // key per branch there was no device to name, so every turnstile
        // row was written with a null deviceId.
        expect(res.body.data.deviceId).toBe(turnstileId);
      });

      it('will not accept a kiosk key at the turnstile, or the reverse', async () => {
        // The two routes judge a check-in differently -- the kiosk
        // requires the member's primary branch to match, the turnstile
        // resolves an external id through DeviceMap -- so a key that
        // worked on both would silently change the rules a member is let
        // in under. `kind` is part of the lookup, so the mismatch is the
        // same 401 as a key that was never issued.
        await request(app.getHttpServer())
          .post('/devices/check-in')
          .send({ deviceKey, externalUserId })
          .expect(401);

        await checkIn({
          deviceKey: turnstileKey,
          memberId: eligibleMemberId,
        }).expect(401);
      });

      it('revokes one device without touching any other', async () => {
        const second = await asOwner(
          request(app.getHttpServer())
            .post('/devices')
            .send({ branchId, name: 'Side Turnstile', kind: 'BIOMETRIC' }),
        ).expect(201);

        const revoked = await asOwner(
          request(app.getHttpServer()).post(`/devices/${turnstileId}/revoke`),
        ).expect(200);
        expect(revoked.body.data.active).toBe(false);
        expect(revoked.body.data.revokedAt).toBeTruthy();

        await request(app.getHttpServer())
          .post('/devices/check-in')
          .send({ deviceKey: turnstileKey, externalUserId })
          .expect(401);

        // The whole point of per-device keys: the branch keeps working.
        await request(app.getHttpServer())
          .post('/devices/check-in')
          .send({ deviceKey: second.body.data.key, externalUserId })
          .expect(200);
      });

      it('is idempotent about revoking, and keeps the device listed', async () => {
        await asOwner(
          request(app.getHttpServer()).post(`/devices/${turnstileId}/revoke`),
        ).expect(200);

        const list = await asOwner(
          request(app.getHttpServer()).get('/devices').query({ branchId }),
        ).expect(200);
        const row = list.body.data.items.find(
          (d: { id: string }) => d.id === turnstileId,
        );
        expect(row.active).toBe(false);
        // A revoked device stays in the registry because the check-ins it
        // recorded stay attributable to it.
        expect(row.name).toBe('Main Turnstile');
      });

      it('never returns a key or its digest from the listing', async () => {
        const list = await asOwner(
          request(app.getHttpServer()).get('/devices'),
        ).expect(200);
        expect(list.body.data.items.length).toBeGreaterThan(0);
        for (const device of list.body.data.items) {
          expect(device.keyHash).toBeUndefined();
          expect(device.key).toBeUndefined();
        }
      });

      it('refuses to revoke a device in another organization', async () => {
        await asOwner(
          request(app.getHttpServer()).post(
            '/devices/00000000-0000-0000-0000-000000000000/revoke',
          ),
        ).expect(404);
      });

      it('denies a caller without kiosk.manage', async () => {
        await authed(trainerToken)(
          request(app.getHttpServer()).get('/devices'),
        ).expect(403);

        await authed(trainerToken)(
          request(app.getHttpServer()).post(`/devices/${turnstileId}/revoke`),
        ).expect(403);
      });
    });
  });
});
