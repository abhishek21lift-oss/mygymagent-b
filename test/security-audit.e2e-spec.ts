import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import request from 'supertest';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

const PASSWORD = 'CorrectHorseBattery9';

/**
 * The account-safety holes the audit found: an admin could take a gym
 * from its owner, an email typed in another case was another person,
 * and a password reset left the account locked.
 */
describe('Security audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let ownerId: string;
  let organizationId: string;
  let branchId: string;
  let adminId: string;
  let adminToken: string;
  let ownerEmail: string;

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

  function login(email: string, password = PASSWORD) {
    return request(server()).post('/auth/login').send({ email, password });
  }

  /** Invites a staff member with `roleKey` and gives them a password. */
  async function staff(roleKey: string, label: string) {
    const email = `${label}-${Date.now()}@example.com`;
    const invited = await as(ownerToken)
      .post('/users')
      .send({
        email,
        firstName: label,
        lastName: 'Staff',
        primaryBranchId: branchId,
        roleKey,
      })
      .expect(201);
    await prisma.user.update({
      where: { id: invited.body.data.id },
      data: { status: 'ACTIVE', passwordHash: await argon2.hash(PASSWORD) },
    });
    const session = await login(email).expect(201);
    return {
      id: invited.body.data.id as string,
      token: session.body.data.accessToken as string,
    };
  }

  function ownerGrantOf(userId: string) {
    return prisma.userRole.findFirstOrThrow({
      where: { userId, role: { key: 'ORG_OWNER' } },
    });
  }

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    ownerEmail = `Owner.Mixed-${Date.now()}@Example.com`;
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Security Audit Gym',
        email: ownerEmail,
        password: PASSWORD,
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    ownerToken = res.body.data.accessToken;
    ownerId = res.body.data.user.id;
    organizationId = res.body.data.organization.id;
    branchId = (await as(ownerToken).get('/branches').expect(200)).body.data
      .items[0].id;
    const admin = await staff('ORG_ADMIN', 'admin');
    adminId = admin.id;
    adminToken = admin.token;
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  describe('an admin cannot take the gym from its owner', () => {
    it('cannot make themselves an owner', async () => {
      await as(adminToken)
        .post(`/users/${adminId}/roles`)
        .send({ roleKey: 'ORG_OWNER' })
        .expect(403);
    });

    it("cannot suspend, edit or remove the owner's account", async () => {
      await as(adminToken)
        .patch(`/users/${ownerId}`)
        .send({ status: 'SUSPENDED' })
        .expect(403);
      await as(adminToken)
        .patch(`/users/${ownerId}`)
        .send({ firstName: 'Hijacked' })
        .expect(403);
      await as(adminToken).delete(`/users/${ownerId}`).expect(403);
      const grant = await ownerGrantOf(ownerId);
      await as(adminToken)
        .delete(`/users/${ownerId}/roles/${grant.id}`)
        .expect(403);

      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: ownerId },
      });
      expect(owner.status).toBe('ACTIVE');
      expect(owner.firstName).toBe('Owner');
    });

    it('can still manage other staff and their own account', async () => {
      const coach = await staff('TRAINER', 'coach');
      await as(adminToken)
        .patch(`/users/${coach.id}`)
        .send({ jobTitle: 'Head coach' })
        .expect(200);
      await as(adminToken)
        .patch(`/users/${adminId}`)
        .send({ firstName: 'Admin' })
        .expect(200);
    });

    it('records who granted a role, not who received it', async () => {
      const coach = await staff('TRAINER', 'granted');
      await as(adminToken)
        .post(`/users/${coach.id}/roles`)
        .send({ roleKey: 'RECEPTIONIST' })
        .expect(201);
      const entries = await prisma.auditLog.findMany({
        where: { organizationId, action: 'assign_role', resourceId: coach.id },
      });
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.actorUserId === adminId)).toBe(true);
    });

    it("refuses a role at another gym's branch", async () => {
      const other = await request(server())
        .post('/auth/register')
        .send({
          organizationName: 'Other Security Gym',
          email: `other-sec-${Date.now()}@example.com`,
          password: PASSWORD,
          firstName: 'Other',
          lastName: 'Owner',
        })
        .expect(201);
      const otherBranch = (
        await as(other.body.data.accessToken).get('/branches').expect(200)
      ).body.data.items[0].id;
      await as(ownerToken)
        .post(`/users/${adminId}/roles`)
        .send({ roleKey: 'TRAINER', branchId: otherBranch })
        .expect(400);
    });
  });

  describe('the gym always keeps an owner', () => {
    it('refuses to let the only owner leave', async () => {
      await as(ownerToken).delete(`/users/${ownerId}`).expect(400);
      await as(ownerToken)
        .patch(`/users/${ownerId}`)
        .send({ status: 'SUSPENDED' })
        .expect(400);
      const grant = await ownerGrantOf(ownerId);
      await as(ownerToken)
        .delete(`/users/${ownerId}/roles/${grant.id}`)
        .expect(400);
    });

    it('lets an owner hand ownership on, then step back', async () => {
      await as(ownerToken)
        .post(`/users/${adminId}/roles`)
        .send({ roleKey: 'ORG_OWNER' })
        .expect(201);
      const grant = await ownerGrantOf(ownerId);
      await as(ownerToken)
        .delete(`/users/${ownerId}/roles/${grant.id}`)
        .expect(200);
      // Hand it back so the rest of the suite has its owner.
      await as(adminToken)
        .post(`/users/${ownerId}/roles`)
        .send({ roleKey: 'ORG_OWNER' })
        .expect(201);
    });
  });

  describe('email addresses', () => {
    it('signs in whatever case the address is typed in', async () => {
      await login(ownerEmail.toLowerCase()).expect(201);
      await login(`  ${ownerEmail.toUpperCase()} `).expect(201);
    });

    it('refuses a second account for the same address in another case', async () => {
      await request(server())
        .post('/auth/register')
        .send({
          organizationName: 'Duplicate Gym',
          email: ownerEmail.toUpperCase(),
          password: PASSWORD,
          firstName: 'Copy',
          lastName: 'Cat',
        })
        .expect(409);
    });
  });

  describe('password reset', () => {
    it('ends a lockout and works once', async () => {
      const locked = await staff('TRAINER', 'locked');
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: locked.id },
      });
      for (let i = 0; i < 5; i++) {
        await login(user.email!, 'WrongPassword123').expect(401);
      }
      await login(user.email!).expect(401);

      const token = generateOpaqueToken();
      await prisma.passwordResetToken.create({
        data: {
          userId: locked.id,
          tokenHash: hashOpaqueToken(token),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const [first, second] = await Promise.all([
        request(server())
          .post('/auth/reset-password')
          .send({ token, newPassword: 'BrandNewPassword42' }),
        request(server())
          .post('/auth/reset-password')
          .send({ token, newPassword: 'SomeoneElses9999' }),
      ]);
      expect([first.status, second.status].sort()).toEqual([204, 400]);

      const winner =
        first.status === 204 ? 'BrandNewPassword42' : 'SomeoneElses9999';
      await login(user.email!, winner).expect(201);
    });
  });
});
