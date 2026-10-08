import { createHmac } from 'crypto';
import { WhatsappService } from './whatsapp.service';

const SECRET = 'test-wa-akg-webhook-secret';

function serviceWith(secret: string | undefined, orgExists = true) {
  const config = {
    get: (key: string, defaultValue?: string) => {
      if (key === 'WA_AKG_WEBHOOK_SECRET') return secret ?? defaultValue ?? '';
      if (key === 'NODE_ENV') return 'test';
      return defaultValue ?? '';
    },
  };
  const filed: Array<{ organizationId: string; from: string; body: string }> =
    [];
  const inbound = {
    file: jest.fn(
      async (organizationId: string, from: string, body: string) => {
        filed.push({ organizationId, from, body });
        return { id: 'inbound_1' };
      },
    ),
  };
  const updates: Array<{ where: unknown; data: unknown }> = [];
  const prisma = {
    organization: {
      findUnique: jest
        .fn()
        .mockResolvedValue(orgExists ? { id: 'org_1' } : null),
    },
    messageLog: {
      updateMany: jest.fn(async (args: unknown) => {
        updates.push(args as never);
        return { count: 1 };
      }),
    },
  };
  const svc = new WhatsappService(
    prisma as never,
    config as never,
    {} as never,
    inbound as never,
    {} as never,
  );
  return { svc, filed, updates };
}

function sign(body: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('WhatsappService.verifyWaAkgSignature', () => {
  const body = Buffer.from(JSON.stringify({ event: 'test' }));

  it('accepts a correctly signed payload', () => {
    const { svc } = serviceWith(SECRET);
    expect(() =>
      svc.verifyWaAkgSignature(body, sign(body, SECRET)),
    ).not.toThrow();
  });

  it('rejects a forged signature', () => {
    const { svc } = serviceWith(SECRET);
    expect(() =>
      svc.verifyWaAkgSignature(body, sign(body, 'wrong-secret')),
    ).toThrow(/Invalid webhook signature/);
  });

  it('rejects a missing signature', () => {
    const { svc } = serviceWith(SECRET);
    expect(() => svc.verifyWaAkgSignature(body, undefined)).toThrow(
      /Invalid webhook signature/,
    );
  });
});

describe('WhatsappService.handleWebhook', () => {
  const received = (overrides = {}) => ({
    event: 'message.received',
    sessionId: 'gym-org_1',
    timestamp: new Date().toISOString(),
    data: {
      key: { id: 'WAID1', fromMe: false },
      from: '919876543210@s.whatsapp.net',
      isGroup: false,
      type: 'TEXT',
      content: 'Hi, what are your timings?',
      ...overrides,
    },
  });

  it('files an inbound text into the CRM queue', async () => {
    const { svc, filed } = serviceWith(SECRET);
    const result = await svc.handleWebhook(received());
    expect(result).toEqual({ received: true });
    expect(filed).toEqual([
      {
        organizationId: 'org_1',
        from: '919876543210',
        body: 'Hi, what are your timings?',
      },
    ]);
  });

  it('acks unknown sessions without filing anything', async () => {
    const { svc, filed } = serviceWith(SECRET, false);
    const result = await svc.handleWebhook(received());
    expect(result).toEqual({ received: true });
    expect(filed).toEqual([]);
  });

  it('ignores own-number echoes and group messages', async () => {
    const { svc, filed } = serviceWith(SECRET);
    await svc.handleWebhook(received({ key: { id: 'WAID2', fromMe: true } }));
    await svc.handleWebhook(received({ isGroup: true }));
    expect(filed).toEqual([]);
  });

  it('advances MessageLog on delivery status', async () => {
    const { svc, updates } = serviceWith(SECRET);
    const result = await svc.handleWebhook({
      event: 'message.status',
      sessionId: 'gym-org_1',
      timestamp: new Date().toISOString(),
      data: { keyId: 'WAID9', status: 'DELIVERED' },
    });
    expect(result).toEqual({ received: true });
    expect(updates).toEqual([
      {
        where: { providerMessageId: 'waakg:WAID9', organizationId: 'org_1' },
        data: { status: 'DELIVERED' },
      },
    ]);
  });
});
