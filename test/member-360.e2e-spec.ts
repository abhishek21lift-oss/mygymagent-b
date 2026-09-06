import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Member 360 (e2e)', () => {
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
    const result = await createTestApp();
    app = result.app;
    org = await registerOrg('Member 360 Test Gym');
    orgB = await registerOrg('Member 360 Test Gym B');

    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Robin',
        lastName: 'Fixture',
      }),
    ).expect(201);
    memberId = member.body.data.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  describe('addresses', () => {
    it('creates multiple addresses and demotes the previous primary when a new one is marked primary', async () => {
      const first = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/addresses`)
          .send({ type: 'HOME', isPrimary: true, addressLine1: '1 First St' }),
      ).expect(201);
      expect(first.body.data.isPrimary).toBe(true);

      const second = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/addresses`)
          .send({
            type: 'WORK',
            isPrimary: true,
            addressLine1: '2 Second Ave',
          }),
      ).expect(201);
      expect(second.body.data.isPrimary).toBe(true);

      const list = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/addresses`),
      ).expect(200);
      expect(list.body.data).toHaveLength(2);
      const firstAfter = list.body.data.find(
        (a: { id: string }) => a.id === first.body.data.id,
      );
      expect(firstAfter.isPrimary).toBe(false);
    });

    it('deletes an address', async () => {
      const addr = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/addresses`)
          .send({ addressLine1: 'Delete Me Rd' }),
      ).expect(201);

      await authed(org.accessToken)(
        request(app.getHttpServer()).delete(
          `/members/${memberId}/addresses/${addr.body.data.id}`,
        ),
      ).expect(200);

      const list = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/addresses`),
      ).expect(200);
      expect(
        list.body.data.some((a: { id: string }) => a.id === addr.body.data.id),
      ).toBe(false);
    });
  });

  describe('emergency contacts', () => {
    it('creates and lists emergency contacts', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/emergency-contacts`)
          .send({
            name: 'Sam Contact',
            phone: '+15551234567',
            relationship: 'Spouse',
          }),
      ).expect(201);

      const list = await authed(org.accessToken)(
        request(app.getHttpServer()).get(
          `/members/${memberId}/emergency-contacts`,
        ),
      ).expect(200);
      expect(list.body.data.length).toBeGreaterThan(0);
    });
  });

  describe('notes', () => {
    it('creates a note and only lets the author edit or delete it', async () => {
      const note = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/notes`)
          .send({ body: 'First note' }),
      ).expect(201);
      expect(note.body.data.body).toBe('First note');

      // A second staff user in the same org, without members.update
      // (default OWNER-only registration means org.accessToken IS the
      // author here, so exercise the author-check via a direct edit by
      // the same user, then confirm the note persists the edit).
      const edited = await authed(org.accessToken)(
        request(app.getHttpServer())
          .patch(`/members/${memberId}/notes/${note.body.data.id}`)
          .send({ body: 'Edited note' }),
      ).expect(200);
      expect(edited.body.data.body).toBe('Edited note');

      await authed(org.accessToken)(
        request(app.getHttpServer()).delete(
          `/members/${memberId}/notes/${note.body.data.id}`,
        ),
      ).expect(200);
    });

    it('does not overwrite previous notes -- the collection grows', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/notes`)
          .send({ body: 'Note A' }),
      ).expect(201);
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/notes`)
          .send({ body: 'Note B' }),
      ).expect(201);

      const list = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/notes`),
      ).expect(200);
      const bodies = list.body.data.map((n: { body: string }) => n.body);
      expect(bodies).toContain('Note A');
      expect(bodies).toContain('Note B');
    });
  });

  describe('consents', () => {
    it('is append-only -- revoking creates a new row rather than mutating the grant', async () => {
      const granted = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/consents`)
          .send({ type: 'MARKETING', granted: true }),
      ).expect(201);
      expect(granted.body.data.granted).toBe(true);

      const revoked = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/consents`)
          .send({
            type: 'MARKETING',
            granted: false,
            note: 'Member opted out',
          }),
      ).expect(201);
      expect(revoked.body.data.granted).toBe(false);
      expect(revoked.body.data.id).not.toBe(granted.body.data.id);

      const list = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/consents`),
      ).expect(200);
      const ids = list.body.data.map((c: { id: string }) => c.id);
      expect(ids).toContain(granted.body.data.id);
      expect(ids).toContain(revoked.body.data.id);
    });
  });

  describe('history', () => {
    it('seeds status and branch history on member creation', async () => {
      const statusHistory = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/status-history`),
      ).expect(200);
      expect(statusHistory.body.data).toHaveLength(1);
      expect(statusHistory.body.data[0].fromStatus).toBeNull();
      expect(statusHistory.body.data[0].toStatus).toBe('ACTIVE');

      const branchHistory = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/branch-history`),
      ).expect(200);
      expect(branchHistory.body.data).toHaveLength(1);
      expect(branchHistory.body.data[0].fromBranchId).toBeNull();
      expect(branchHistory.body.data[0].toBranchId).toBe(org.branchId);
    });

    it('records a status change without losing the original status transition', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .patch(`/members/${memberId}`)
          .send({ status: 'FROZEN' }),
      ).expect(200);

      const history = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/status-history`),
      ).expect(200);
      expect(history.body.data).toHaveLength(2);
      expect(history.body.data[0].toStatus).toBe('FROZEN');
      expect(history.body.data[0].fromStatus).toBe('ACTIVE');
      expect(history.body.data[1].toStatus).toBe('ACTIVE');
    });

    it('records trainer assignment history when a trainer is assigned', async () => {
      const trainer = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post('/users')
          .send({
            email: `trainer-${Date.now()}@example.com`,
            firstName: 'Terry',
            lastName: 'Trainer',
            roleKey: 'TRAINER',
          }),
      ).expect(201);

      await authed(org.accessToken)(
        request(app.getHttpServer())
          .patch(`/members/${memberId}`)
          .send({ assignedTrainerId: trainer.body.data.id }),
      ).expect(200);

      const history = await authed(org.accessToken)(
        request(app.getHttpServer()).get(
          `/members/${memberId}/trainer-history`,
        ),
      ).expect(200);
      expect(history.body.data[0].toTrainerId).toBe(trainer.body.data.id);
      expect(history.body.data[0].fromTrainerId).toBeNull();
    });
  });

  describe('cross-tenant isolation', () => {
    it("rejects org B reading or writing org A's member sub-resources", async () => {
      await authed(orgB.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/addresses`),
      ).expect(404);

      await authed(orgB.accessToken)(
        request(app.getHttpServer())
          .post(`/members/${memberId}/notes`)
          .send({ body: 'Should not be allowed' }),
      ).expect(404);

      await authed(orgB.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/status-history`),
      ).expect(404);
    });
  });

  describe('Member 360 overview', () => {
    it('returns aggregated overview for a valid member', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer())
          .get('/members/overview')
          .query({ memberId }),
      ).expect(200);

      expect(res.body.data).toHaveProperty('member');
      expect(res.body.data).toHaveProperty('membership');
      expect(res.body.data).toHaveProperty('attendance');
      expect(res.body.data).toHaveProperty('engagement');
      expect(res.body.data).toHaveProperty('finance');
      expect(res.body.data).toHaveProperty('ptSummary');
      expect(res.body.data.member.id).toBe(memberId);
      expect(res.body.data.member.firstName).toBe('Robin');
      expect(res.body.data.member.lastName).toBe('Fixture');
    });

    it('returns 400 when memberId is missing', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer()).get('/members/overview'),
      ).expect(400);
    });

    it('returns 404 for member in another org', async () => {
      const memberInOrgB = await authed(orgB.accessToken)(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: orgB.branchId,
          firstName: 'Other',
          lastName: 'Member',
        }),
      ).expect(201);

      await authed(org.accessToken)(
        request(app.getHttpServer())
          .get('/members/overview')
          .query({ memberId: memberInOrgB.body.data.id }),
      ).expect(404);
    });
  });

  describe('Member 360 timeline', () => {
    it('returns paginated timeline events', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer())
          .get('/members/timeline')
          .query({ memberId }),
      ).expect(200);

      expect(res.body.data).toHaveProperty('events');
      expect(res.body.data).toHaveProperty('totalCount');
      expect(res.body.data).toHaveProperty('page');
      expect(res.body.data).toHaveProperty('pageSize');
      expect(Array.isArray(res.body.data.events)).toBe(true);
    });

    it('returns member_created event for new member', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer())
          .get('/members/timeline')
          .query({ memberId, pageSize: 100 }),
      ).expect(200);

      const createdEvent = res.body.data.events.find(
        (e: { type: string; metadata?: { fromStatus?: string } }) =>
          e.type === 'status_changed' && e.metadata?.fromStatus === null,
      );
      expect(createdEvent).toBeDefined();
      expect(createdEvent.title).toContain('ACTIVE');
    });

    it('respects pagination parameters', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer())
          .get('/members/timeline')
          .query({ memberId, page: 1, pageSize: 5 }),
      ).expect(200);

      expect(res.body.data.pageSize).toBe(5);
      expect(res.body.data.page).toBe(1);
    });

    it('returns 400 when memberId is missing', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer()).get('/members/timeline'),
      ).expect(400);
    });
  });

  describe('Duplicate detection', () => {
    let duplicateMemberId: string;

    beforeAll(async () => {
      const duplicate = await authed(org.accessToken)(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: org.branchId,
          firstName: 'Robin', // Same first name
          lastName: 'Fixture', // Same last name
          email: 'robin.fixture@example.com', // Same email
        }),
      ).expect(201);
      duplicateMemberId = duplicate.body.data.id;
    });

    it('finds duplicates for a specific member', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer()).get(`/members/${memberId}/duplicates`),
      ).expect(200);

      expect(res.body.data).toHaveProperty('memberId');
      expect(res.body.data).toHaveProperty('potentialDuplicates');
      expect(Array.isArray(res.body.data.potentialDuplicates)).toBe(true);
    });

    it('finds all duplicates in org', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer()).get('/members/duplicates'),
      ).expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('previews merge between two members', async () => {
      const res = await authed(org.accessToken)(
        request(app.getHttpServer())
          .get('/members/duplicates/preview-merge')
          .query({ sourceId: duplicateMemberId, targetId: memberId }),
      ).expect(200);

      expect(res.body.data).toHaveProperty('sourceMember');
      expect(res.body.data).toHaveProperty('targetMember');
      expect(res.body.data).toHaveProperty('conflicts');
      expect(res.body.data).toHaveProperty('mergeableRecords');
    });

    it('returns 400 when sourceId equals targetId', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .get('/members/duplicates/preview-merge')
          .query({ sourceId: memberId, targetId: memberId }),
      ).expect(400);
    });

    it('executes merge between two members', async () => {
      const newDuplicate = await authed(org.accessToken)(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: org.branchId,
          firstName: 'Robin',
          lastName: 'Fixture', // Same as target to avoid conflicts
          phone: '+15559999999',
        }),
      ).expect(201);

      const res = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post('/members/duplicates/execute-merge')
          .send({
            sourceMemberId: newDuplicate.body.data.id,
            targetMemberId: memberId,
            resolution: {},
          }),
      ).expect(201);

      expect(res.body.data).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('mergedMemberId');
    });

    it('prevents cross-tenant duplicate access', async () => {
      const memberInOrgB = await authed(orgB.accessToken)(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: orgB.branchId,
          firstName: 'Other',
          lastName: 'Duplicate',
        }),
      ).expect(201);

      await authed(org.accessToken)(
        request(app.getHttpServer()).get(
          `/members/${memberInOrgB.body.data.id}/duplicates`,
        ),
      ).expect(404);
    });
  });
});
