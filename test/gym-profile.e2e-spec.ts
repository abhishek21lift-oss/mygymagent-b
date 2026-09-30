import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/** A real 1×1 PNG: the upload checks the bytes, not the file name. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Settings → Gym profile: the gym's contact details, logo, email sender,
 * and each branch's address, directions and opening hours.
 */
describe('Gym profile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gym: RegisteredAccount;
  let other: RegisteredAccount;

  const server = () => app.getHttpServer();
  const as = (token: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      request(server()).patch(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) =>
      request(server()).delete(url).set('Authorization', `Bearer ${token}`),
  });

  async function register(name: string): Promise<RegisteredAccount> {
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: name,
        email: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    const token = res.body.data.accessToken;
    const branches = await as(token).get('/branches').expect(200);
    return {
      accessToken: token,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
  }

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    gym = await register('Profile Fitness');
    other = await register('Other Profile Gym');
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  describe('contact details', () => {
    it('saves them, stripping the "@" from the Instagram handle', async () => {
      const res = await as(gym.accessToken)
        .patch('/organizations/current')
        .send({
          contactPhone: '+91 98765 43210',
          contactEmail: 'hello@profilefitness.in',
          website: 'https://profilefitness.in',
          instagram: '@profile.fitness',
          emailFromName: 'Profile Fitness',
          emailReplyTo: 'desk@profilefitness.in',
          timezone: 'Asia/Kolkata',
          currency: 'INR',
        })
        .expect(200);
      expect(res.body.data).toMatchObject({
        contactPhone: '+91 98765 43210',
        contactEmail: 'hello@profilefitness.in',
        website: 'https://profilefitness.in',
        instagram: 'profile.fitness',
        emailFromName: 'Profile Fitness',
        emailReplyTo: 'desk@profilefitness.in',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        logoUrl: null,
      });
      expect(res.body.data).not.toHaveProperty('logoKey');
    });

    it('clears a field sent blank', async () => {
      const res = await as(gym.accessToken)
        .patch('/organizations/current')
        .send({ website: '', instagram: ' ' })
        .expect(200);
      expect(res.body.data).toMatchObject({ website: null, instagram: null });
      expect(res.body.data.contactPhone).toBe('+91 98765 43210');
    });

    it.each([
      [{ timezone: 'India' }, 'timezone'],
      [{ currency: 'rupees' }, 'currency'],
      [{ contactEmail: 'not-an-email' }, 'contactEmail'],
      [{ website: 'profilefitness' }, 'website'],
      [{ instagram: 'has spaces' }, 'instagram'],
      [{ contactPhone: 'call me' }, 'contactPhone'],
    ])('refuses %j', async (body, field) => {
      const res = await as(gym.accessToken)
        .patch('/organizations/current')
        .send(body)
        .expect(400);
      expect(JSON.stringify(res.body)).toContain(field);
    });

    it("never shows one gym another's details", async () => {
      const res = await as(other.accessToken)
        .get('/organizations/current')
        .expect(200);
      expect(res.body.data.contactEmail).toBeNull();
      expect(res.body.data.name).toBe('Other Profile Gym');
    });
  });

  describe('logo', () => {
    it('uploads, shows as a link, replaces and removes', async () => {
      const first = await as(gym.accessToken)
        .post('/organizations/current/logo')
        .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
        .expect(201);
      expect(first.body.data.logoUrl).toMatch(/^https?:\/\//);
      expect(first.body.data).not.toHaveProperty('logoKey');
      const firstKey = (
        await prisma.organization.findUniqueOrThrow({
          where: { id: gym.organizationId },
        })
      ).logoKey;
      expect(firstKey).toMatch(
        new RegExp(`^org/${gym.organizationId}/branding/`),
      );

      // The link works.
      const image = await request(first.body.data.logoUrl as string).get('');
      expect(image.status).toBe(200);

      const again = await as(gym.accessToken)
        .get('/organizations/current')
        .expect(200);
      expect(again.body.data.logoUrl).toMatch(/^https?:\/\//);

      await as(gym.accessToken)
        .post('/organizations/current/logo')
        .attach('file', PNG, { filename: 'new.png', contentType: 'image/png' })
        .expect(201);
      const secondKey = (
        await prisma.organization.findUniqueOrThrow({
          where: { id: gym.organizationId },
        })
      ).logoKey;
      expect(secondKey).not.toBe(firstKey);
      // The replaced image is deleted, not left in storage.
      const stale = await request(first.body.data.logoUrl as string).get('');
      expect(stale.status).toBe(404);

      const removed = await as(gym.accessToken)
        .delete('/organizations/current/logo')
        .expect(200);
      expect(removed.body.data.logoUrl).toBeNull();
    });

    it('refuses a file that is not an image, whatever it is called', async () => {
      const res = await as(gym.accessToken)
        .post('/organizations/current/logo')
        .attach('file', Buffer.from('%PDF-1.4 not a logo'), {
          filename: 'logo.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(res.body.message ?? JSON.stringify(res.body)).toMatch(
        /PNG, JPEG or WebP/,
      );
    });

    it('refuses an upload with no file', async () => {
      await as(gym.accessToken).post('/organizations/current/logo').expect(400);
    });
  });

  describe('branch address, directions and hours', () => {
    const hours = [0, 1, 2, 3, 4, 5].flatMap((day) => [
      { day, open: '16:00', close: '22:00' },
      { day, open: '05:00', close: '11:00' },
    ]);

    it('saves them, hours sorted', async () => {
      const res = await as(gym.accessToken)
        .patch(`/branches/${gym.branchId}`)
        .send({
          addressLine1: '12 MG Road',
          state: 'Maharashtra',
          postalCode: '411001',
          mapsUrl: 'https://maps.app.goo.gl/abc123',
          openingHours: hours,
        })
        .expect(200);
      expect(res.body.data).toMatchObject({
        addressLine1: '12 MG Road',
        state: 'Maharashtra',
        postalCode: '411001',
        mapsUrl: 'https://maps.app.goo.gl/abc123',
      });
      expect(res.body.data.openingHours.slice(0, 2)).toEqual([
        { day: 0, open: '05:00', close: '11:00' },
        { day: 0, open: '16:00', close: '22:00' },
      ]);
    });

    it.each([
      [[{ day: 0, open: '22:00', close: '06:00' }], /Mon: closing time/],
      [
        [
          { day: 1, open: '05:00', close: '12:00' },
          { day: 1, open: '11:00', close: '20:00' },
        ],
        /overlap/,
      ],
      [[{ day: 7, open: '05:00', close: '12:00' }], /day/],
      [[{ day: 0, open: '5am', close: '12:00' }], /open must be a time/],
    ])('refuses bad hours %#', async (openingHours, message) => {
      const res = await as(gym.accessToken)
        .patch(`/branches/${gym.branchId}`)
        .send({ openingHours })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(message);
    });

    it('refuses a directions link that is not https', async () => {
      await as(gym.accessToken)
        .patch(`/branches/${gym.branchId}`)
        .send({ mapsUrl: 'http://maps.example.com/x' })
        .expect(400);
    });

    it('clears hours and directions sent as null', async () => {
      const res = await as(gym.accessToken)
        .patch(`/branches/${gym.branchId}`)
        .send({ openingHours: null, mapsUrl: null })
        .expect(200);
      expect(res.body.data).toMatchObject({
        openingHours: null,
        mapsUrl: null,
        addressLine1: '12 MG Road',
      });
    });

    it("cannot edit another gym's branch", async () => {
      await as(other.accessToken)
        .patch(`/branches/${gym.branchId}`)
        .send({ addressLine1: 'Hijacked' })
        .expect(404);
    });
  });
});
