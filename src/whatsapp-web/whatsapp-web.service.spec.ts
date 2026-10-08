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

function service(session: unknown, configured = true) {
  const waAkg = {
    isConfigured: () => configured,
    getSession: jest.fn().mockResolvedValue(session),
    ensureSession: jest.fn().mockResolvedValue(undefined),
    performAction: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    whatsappWebSession: {
      findUnique: jest.fn().mockResolvedValue(prefs),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    messageLog: { count: jest.fn().mockResolvedValue(0) },
  };
  const svc = new WhatsappWebService(prisma as never, waAkg as never);
  return { svc, waAkg, prisma };
}

describe('WhatsappWebService.availability', () => {
  it('is available when WA-AKG is configured', () => {
    expect(service(null, true).svc.availability()).toEqual({
      available: true,
      unavailableReason: null,
    });
  });

  it('is DISABLED when WA-AKG is not configured', () => {
    expect(service(null, false).svc.availability()).toEqual({
      available: false,
      unavailableReason: 'DISABLED',
    });
  });
});

describe('WhatsappWebService.status', () => {
  it('maps a connected WA-AKG session to CONNECTED with the linked number', async () => {
    const { svc } = service({
      status: 'CONNECTED',
      me: { id: '919876543210@s.whatsapp.net' },
      pairingCode: null,
      qr: null,
    });
    const status = await svc.status('org_123');
    expect(status.status).toBe('CONNECTED');
    expect(status.phoneNumber).toBe('919876543210');
  });

  it('maps SCAN_QR to PAIRING with a QR image', async () => {
    const { svc } = service({ status: 'SCAN_QR', qr: 'some-qr-payload' });
    const status = await svc.status('org_123');
    expect(status.status).toBe('PAIRING');
    expect(status.qrDataUrl?.startsWith('data:image/')).toBe(true);
  });
});

describe('WhatsappWebService.connect', () => {
  it('refuses to link a second number while one is connected', async () => {
    const { svc } = service({
      status: 'CONNECTED',
      me: { id: '919876543210@s.whatsapp.net' },
    });
    await expect(
      svc.connect('org_123', 'user_1', { acceptRisk: true }),
    ).rejects.toThrow(/already linked/i);
  });
});
