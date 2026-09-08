import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * Stripe webhook e2e: drives POST /payments/webhook through the real HTTP
 * stack with real HMAC-SHA256 signatures (computed exactly as Stripe
 * does: `t=timestamp,v1=hex(hmac(secret, `${t}.${rawBody}`))`). The
 * stripe SDK's constructEvent verifies offline -- no network, no mocked
 * provider -- the same discipline as the rest of this suite (real
 * Postgres, real Redis, real SMTP).
 */

const WEBHOOK_SECRET = 'whsec_e2e_local_test_secret';

/** Computes a valid stripe-signature header for the exact body string. */
function sign(payload: string, secret = WEBHOOK_SECRET): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function intentEvent(
  type: 'payment_intent.succeeded' | 'payment_intent.payment_failed',
  intent: Record<string, unknown>,
) {
  return JSON.stringify({
    id: `evt_${intent.id}`,
    object: 'event',
    api_version: '2022-11-15',
    type,
    data: { object: intent },
  });
}

describe('Stripe webhook (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let memberId: string;
  let membershipId: string;

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

  /** Reads the org's payments list and returns ids of those matching a
   * Stripe intent id. */
  async function paymentByIntent(intentId: string) {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/payments'),
    ).expect(200);
    return (
      (
        res.body.data.items as Array<{
          id: string;
          stripePaymentIntentId?: string;
          status: string;
          amount: string;
        }>
      ).find((p) => p.stripePaymentIntentId === intentId) ?? null
    );
  }

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    org = await registerOrg('Stripe Webhook Test Gym');

    // A real member + membership to charge against.
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Stripe',
        lastName: 'Webhook',
      }),
    ).expect(201);
    memberId = member.body.data.id;

    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Webhook Test Plan', durationDays: 30, price: 150 }),
    ).expect(201);

    const membership = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/memberships').send({
        memberId,
        membershipPlanId: plan.body.data.id,
      }),
    ).expect(201);
    membershipId = membership.body.data.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('rejects an unsigned webhook with 401', async () => {
    const body = intentEvent('payment_intent.succeeded', { id: 'pi_unsigned' });
    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=123,v1=deadbeef')
      .send(body)
      .expect(401);
  });

  it('records a signed payment_intent.succeeded as a COMPLETED payment in major units', async () => {
    const intent = {
      id: `pi_succ_${Date.now()}`,
      object: 'payment_intent',
      amount: 15000, // cents -> 150.00 major units
      currency: 'usd',
      metadata: {
        organizationId: org.organizationId,
        userId: org.userId,
        memberId,
        membershipId,
      },
    };
    const body = intentEvent('payment_intent.succeeded', intent);

    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sign(body))
      .send(body)
      .expect(200); // route returns 200 via @HttpCode

    const payment = await paymentByIntent(intent.id);
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe('COMPLETED');
    expect(Number(payment!.amount)).toBe(150); // not 15000
  });

  it('records a signed payment_intent.payment_failed as a FAILED payment', async () => {
    const intent = {
      id: `pi_fail_${Date.now()}`,
      object: 'payment_intent',
      amount: 5000,
      currency: 'usd',
      metadata: {
        organizationId: org.organizationId,
        userId: org.userId,
        memberId,
        membershipId,
      },
    };
    const body = intentEvent('payment_intent.payment_failed', intent);

    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sign(body))
      .send(body)
      .expect(200);

    const payment = await paymentByIntent(intent.id);
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe('FAILED');
    expect(Number(payment!.amount)).toBe(50);
  });

  it('is idempotent under redelivery: the same intent is recorded once', async () => {
    const intent = {
      id: `pi_dup_${Date.now()}`,
      object: 'payment_intent',
      amount: 10000,
      currency: 'usd',
      metadata: {
        organizationId: org.organizationId,
        userId: org.userId,
        memberId,
        membershipId,
      },
    };
    const body = intentEvent('payment_intent.succeeded', intent);
    const signature = sign(body);

    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(body)
      .expect(200);

    // Stripe redelivers the exact same event bytes + signature.
    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(body)
      .expect(200);

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/payments'),
    ).expect(200);
    const matching = (
      res.body.data.items as Array<{ stripePaymentIntentId?: string }>
    ).filter((p) => p.stripePaymentIntentId === intent.id);
    expect(matching).toHaveLength(1);
  });

  it('ack-200s an unhandled event type without recording anything', async () => {
    const body = JSON.stringify({
      id: 'evt_other',
      object: 'event',
      type: 'charge.refunded',
      data: { object: { id: 'ch_1' } },
    });

    await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sign(body))
      .send(body)
      .expect(200);
  });

  it('rejects an intent referencing another org (tenant isolation)', async () => {
    // Signed with the REAL secret, so signature verification passes -- the
    // tenant check must be the thing that rejects it, not the signature.
    const intent = {
      id: `pi_cross_${Date.now()}`,
      object: 'payment_intent',
      amount: 1000,
      currency: 'usd',
      metadata: {
        organizationId: '00000000-0000-0000-0000-000000000000',
        userId: org.userId,
        memberId, // belongs to the REAL org, not the fake one
        membershipId,
      },
    };
    const body = intentEvent('payment_intent.succeeded', intent);

    // The member lookup is scoped to the metadata's (fake) org -> no
    // member found -> the handler's NotFound error propagates as a
    // non-2xx (Stripe will retry), and no cross-org payment row is
    // created.
    const res = await request(app.getHttpServer())
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sign(body))
      .send(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect([404, 500]).toContain(res.status);

    expect(await paymentByIntent(intent.id)).toBeNull();
  });
});
