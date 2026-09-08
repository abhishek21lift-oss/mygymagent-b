import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Member sub-resources (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let orgB: RegisteredAccount;
  let memberId: string;

  async function registerOrg(name: string): Promise<RegisteredAccount> {
    const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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
    org = await registerOrg('SubResources Test Gym');
    orgB = await registerOrg('SubResources Test Gym B');

    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Robin',
        lastName: 'SubTest',
        email: 'robin@subtest.com',
        phone: '+1234567890',
      }),
    ).expect(201);
    memberId = member.body.data.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  describe('Follow-ups', () => {
    it('creates, lists, updates, completes, and deletes a follow-up', async () => {
      const dueAt = new Date(Date.now() + 86400000).toISOString();
      const created = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/follow-ups`)
          .send({
            title: 'Check-in call',
            dueAt,
            assignedToUserId: org.userId,
          }),
      ).expect(201);
      expect(created.body.data.title).toBe('Check-in call');
      expect(created.body.data.completedAt).toBeNull();

      const listed = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/follow-ups`),
      ).expect(200);
      expect(
        listed.body.data.some(
          (f: { title: string }) => f.title === 'Check-in call',
        ),
      ).toBe(true);

      const followUpId = created.body.data.id;
      const updated = await authed(org.accessToken)(
        request(app.getHttpServer())
          .patch(`/members/${memberId}/follow-ups/${followUpId}`)
          .send({ title: 'Check-in call updated' }),
      ).expect(200);
      expect(updated.body.data.title).toBe('Check-in call updated');

      const completed = await authed(org.accessToken)(
        request(app.getHttpServer()).put(
          `/members/${memberId}/follow-ups/${followUpId}/complete`,
        ),
      ).expect(200);
      expect(completed.body.data.completedAt).not.toBeNull();

      await authed(org.accessToken)(
        request(app.getHttpServer()).delete(
          `/members/${memberId}/follow-ups/${followUpId}`,
        ),
      ).expect(200);

      const listAfter = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/follow-ups`),
      ).expect(200);
      expect(
        listAfter.body.data.some((f: { id: string }) => f.id === followUpId),
      ).toBe(false);
    });

    it('cross-tenant: rejects org B accessing org A follow-ups', async () => {
      await authed(orgB.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/follow-ups`),
      ).expect(404);
      await authed(orgB.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/follow-ups`)
          .send({ title: 'Hack' }),
      ).expect(404);
    });
  });

  describe('Tags', () => {
    let tagId: string;

    it('creates and lists tags', async () => {
      const created = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post('/members/tags')
          .send({ name: 'VIP Member', color: '#ff0000' }),
      ).expect(201);
      expect(created.body.data.name).toBe('VIP Member');
      tagId = created.body.data.id;
      const listed = await authed(org.accessToken)(
        request(app.getHttpServer()).get('/members/tags'),
      ).expect(200);
      expect(
        listed.body.data.some((t: { name: string }) => t.name === 'VIP Member'),
      ).toBe(true);
    });

    it('assigns tags to member', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/tags`)
          .send({ tagIds: [tagId] }),
      ).expect(200);
      const assignments = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/tags`),
      ).expect(200);
      expect(
        assignments.body.data.some((a: { tagId: string }) => a.tagId === tagId),
      ).toBe(true);
    });

    it('cross-tenant: rejects org B accessing org A tags', async () => {
      const orgBTags = (
        await authed(orgB.accessToken)(
          request(app.getHttpServer()).get('/members/tags'),
        ).expect(200)
      ).body.data;
      expect(orgBTags.some((t: { id: string }) => t.id === tagId)).toBe(false);
    });

    it('deletes a tag', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer()).delete(`/members/tags/${tagId}`),
      ).expect(200);
      const listed = await authed(org.accessToken)(
        request(app.getHttpServer()).get('/members/tags'),
      ).expect(200);
      expect(listed.body.data.some((t: { id: string }) => t.id === tagId)).toBe(
        false,
      );
    });
  });

  describe('Bulk actions', () => {
    let member2Id: string;

    beforeAll(async () => {
      const m2 = await authed(org.accessToken)(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: org.branchId,
          firstName: 'Bulk',
          lastName: 'Test',
        }),
      ).expect(201);
      member2Id = m2.body.data.id;
    });

    it('bulk changes member status', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .post('/members/bulk/status')
          .send({ memberIds: [memberId, member2Id], status: 'INACTIVE' }),
      ).expect(200);
      const m1 = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}`),
      ).expect(200);
      expect(m1.body.data.status).toBe('INACTIVE');
      const m2 = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${member2Id}`),
      ).expect(200);
      expect(m2.body.data.status).toBe('INACTIVE');
    });

    it('bulk exports members as CSV', async () => {
      const exported = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post('/members/bulk/export')
          .send({ memberIds: [memberId] }),
      ).expect(200);
      expect(exported.body.data).toBeDefined();
      expect(typeof exported.body.data).toBe('string');
    });

    it('cross-tenant: rejects bulk operations on other org members', async () => {
      const orgBMember = await authed(orgB.accessToken)(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: orgB.branchId,
          firstName: 'OrgB',
          lastName: 'Member',
        }),
      ).expect(201);
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .post('/members/bulk/status')
          .send({ memberIds: [orgBMember.body.data.id], status: 'INACTIVE' }),
      ).expect(200);
      const checked = await authed(orgB.accessToken)(
        request(app.getHttpServer()).get(`/members/${orgBMember.body.data.id}`),
      ).expect(200);
      expect(checked.body.data.status).toBe('ACTIVE');
    });
  });

  describe('Document versioning', () => {
    let documentId: string;

    beforeAll(async () => {
      const uploaded = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/documents`)
          .field('category', 'DOCUMENT')
          .field('description', 'Versioned doc')
          .attach('file', Buffer.from('%PDF-1.4 fake pdf'), {
            filename: 'doc.pdf',
            contentType: 'application/pdf',
          }),
      ).expect(201);
      documentId = uploaded.body.data.id;
    });

    it('submits a draft document', async () => {
      const submitted = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/documents/${documentId}/submit`)
          .send({ changeNotes: 'Ready for review' }),
      ).expect(200);
      expect(submitted.body.data.status).toBe('SUBMITTED');
    });

    it('reviews (approves) a submitted document', async () => {
      const approved = await authed(org.accessToken)(
        request(app.getHttpServer())
          .patch(`/members/${memberId}/documents/${documentId}/review`)
          .send({ action: 'approve' }),
      ).expect(200);
      expect(approved.body.data.status).toBe('APPROVED');
    });

    it('rejects a submitted document with reason', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/documents/${documentId}/versions`)
          .attach('file', Buffer.from('%PDF-1.4 rejection revision'), {
            filename: 'doc-rejection.pdf',
            contentType: 'application/pdf',
          })
          .field('changeNotes', 'Prepare rejection review'),
      ).expect(201);
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/documents/${documentId}/submit`)
          .send({ changeNotes: 'Ready for rejection review' }),
      ).expect(200);
      const rejected = await authed(org.accessToken)(
        request(app.getHttpServer())
          .patch(`/members/${memberId}/documents/${documentId}/review`)
          .send({ action: 'reject', rejectionReason: 'Needs revision' }),
      ).expect(200);
      expect(rejected.body.data.status).toBe('REJECTED');
      expect(rejected.body.data.rejectionReason).toBe('Needs revision');
    });

    it('uploads a new version of a rejected document', async () => {
      const newVersion = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/documents/${documentId}/versions`)
          .attach('file', Buffer.from('%PDF-1.4 version2'), {
            filename: 'doc-v2.pdf',
            contentType: 'application/pdf',
          })
          .field('changeNotes', 'Fixed per feedback'),
      ).expect(201);
      expect(newVersion.body.data.status).toBe('DRAFT');
      expect(newVersion.body.data.versions.length).toBeGreaterThanOrEqual(3);
    });

    it('gets version history', async () => {
      const history = await authed(org.accessToken)(
        request(app.getHttpServer()).get(
          `/members/${memberId}/documents/${documentId}/versions`,
        ),
      ).expect(200);
      expect(Array.isArray(history.body.data)).toBe(true);
      expect(history.body.data.length).toBeGreaterThanOrEqual(3);
    });

    it('cross-tenant: rejects submit/review/upload from other org', async () => {
      await authed(orgB.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/documents/${documentId}/submit`)
          .send({}),
      ).expect(404);
      await authed(orgB.accessToken)(
        request(app.getHttpServer())
          .patch(`/members/${memberId}/documents/${documentId}/review`)
          .send({ action: 'approve' }),
      ).expect(404);
    });
  });

  describe('Communications', () => {
    it('lists message logs for a member', async () => {
      const listed = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/communications`),
      ).expect(200);
      expect(Array.isArray(listed.body.data)).toBe(true);
    });

    it('cross-tenant: rejects org B accessing org A communications', async () => {
      await authed(orgB.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/communications`),
      ).expect(404);
    });
  });
});
