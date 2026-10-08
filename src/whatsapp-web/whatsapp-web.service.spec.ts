import { WhatsappWebService } from './whatsapp-web.service';

const prefs = {
  status: 'DISCONNECTED',
  phoneNumber: null,
  useForSending: false,
  autoReply: true,
  dailyLimit: 200,
  riskAcceptedAt: null,
  connectedAt: null,
  lastError: null,
};

function service(
  session: {
    status?: string;
    phoneNumber?: string | null;
    connectedAt?: Date | null;
    lastError?: string | null;
  } | null,
  configured = true,
) {
  const manager = {
    getStatus: jest.fn(async () => session?.status ?? 'DISCONNECTED'),
    codes: jest.fn(async () => ({ qrDataUrl: null, pairingCode: null })),
    connect: jest.fn(async () => undefined),
    disconnect: jest.fn(async () => undefined),
  };
  const config = {
    get: (key: string) =>
      key === 'WA_AUTH_KEY' && configured ? 'ab'.repeat(32) : undefined,
  };
  const prisma = {
    whatsappWebSession: {
      findUnique: jest.fn(async () => prefs),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    waSession: {
      findUnique: jest.fn(async () => session),
    },
    messageLog: { count: jest.fn(async () => 0) },
  };
  const svc = new WhatsappWebService(
    prisma as never,
    config as never,
    manager as never,
  );
  return { svc, manager, prisma };
}

describe('WhatsappWebService.availability', () => {
  it('is available when the session vault key is configured', () => {
    expect(service(null, true).svc.availability()).toEqual({
      available: true,
      unavailableReason: null,
    });
  });

  it('is DISABLED without the vault key', () => {
    expect(service(null, false).svc.availability()).toEqual({
      available: false,
      unavailableReason: 'DISABLED',
    });
  });
});

describe('WhatsappWebService.status', () => {
  it('reports the live socket over the stored row', async () => {
    const { svc } = service({
      status: 'CONNECTED',
      phoneNumber: '919876543210',
      connectedAt: new Date(),
      lastError: null,
    });
    const status = await svc.status('org_123');
    expect(status.status).toBe('CONNECTED');
    expect(status.phoneNumber).toBe('919876543210');
  });
});

describe('WhatsappWebService.connect', () => {
  it('refuses to link a second number while one is connected', async () => {
    const { svc } = service({ status: 'CONNECTED' });
    await expect(
      svc.connect('org_123', 'user_1', { acceptRisk: true }),
    ).rejects.toThrow(/already linked/i);
  });

  it('starts the manager and records the risk acceptance', async () => {
    const { svc, manager, prisma } = service(null);
    await svc.connect('org_123', 'user_1', { acceptRisk: true });
    expect(manager.connect).toHaveBeenCalledWith('org_123', {
      pairingPhone: undefined,
    });
    expect(prisma.whatsappWebSession.upsert).toHaveBeenCalled();
  });
});
