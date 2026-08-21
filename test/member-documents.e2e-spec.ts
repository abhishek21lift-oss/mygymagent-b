import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Member documents (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let orgB: RegisteredAccount;
  let memberId: string;

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
    app = await createTestApp();
    org = await registerOrg('Files Test Gym');
    orgB = await registerOrg('Files Test Gym B');

    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Doc',
        lastName: 'Uploader',
      }),
    ).expect(201);
    memberId = member.body.data.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('uploads a document, lists it with a working signed URL, and deletes it', async () => {
    const uploaded = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/members/${memberId}/documents`)
        .field('category', 'DOCUMENT')
        .field('description', 'Signed waiver')
        .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), {
          filename: 'waiver.pdf',
          contentType: 'application/pdf',
        }),
    ).expect(201);
    expect(uploaded.body.data.category).toBe('DOCUMENT');
    const documentId = uploaded.body.data.id;

    const list = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/members/${memberId}/documents`),
    ).expect(200);
    const listed = list.body.data.find(
      (d: { id: string }) => d.id === documentId,
    );
    expect(listed).toBeDefined();
    expect(listed.originalName).toBe('waiver.pdf');
    expect(listed.url).toContain('http');

    // The signed URL is a real, fetchable S3 object -- not a mock.
    const fileRes = await fetch(listed.url);
    expect(fileRes.status).toBe(200);
    const fileText = await fileRes.text();
    expect(fileText).toContain('fake pdf content');

    await authed(org.accessToken)(
      request(app.getHttpServer()).delete(
        `/members/${memberId}/documents/${documentId}`,
      ),
    ).expect(200);

    const listAfter = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/members/${memberId}/documents`),
    ).expect(200);
    expect(
      listAfter.body.data.some((d: { id: string }) => d.id === documentId),
    ).toBe(false);

    // The underlying object is actually gone, not just the DB row.
    const fileResAfter = await fetch(listed.url);
    expect(fileResAfter.status).not.toBe(200);
  });

  it('rejects an unsupported file type', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/members/${memberId}/documents`)
        .field('category', 'DOCUMENT')
        .attach('file', Buffer.from('#!/bin/sh\necho hi'), {
          filename: 'script.sh',
          contentType: 'application/x-sh',
        }),
    ).expect(400);
  });

  it('supports progress photos as a category, not a separate resource', async () => {
    const uploaded = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/members/${memberId}/documents`)
        .field('category', 'PROGRESS_PHOTO')
        .attach('file', Buffer.from('fake-jpeg-bytes'), {
          filename: 'progress.jpg',
          contentType: 'image/jpeg',
        }),
    ).expect(201);
    expect(uploaded.body.data.category).toBe('PROGRESS_PHOTO');
  });

  describe('cross-tenant isolation', () => {
    it("rejects org B reading or uploading to org A's member documents", async () => {
      await authed(orgB.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/documents`),
      ).expect(404);

      await authed(orgB.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/documents`)
          .field('category', 'DOCUMENT')
          .attach('file', Buffer.from('nope'), {
            filename: 'x.pdf',
            contentType: 'application/pdf',
          }),
      ).expect(404);
    });
  });
});
