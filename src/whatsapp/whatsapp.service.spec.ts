import { WhatsappService } from './whatsapp.service';

const liveSession = {
  id: 'ws-1',
  sessionId: 'gym-org_123',
  status: 'CONNECTED',
  phoneNumber: '919876543210',
  lastError: null,
  connectedAt: new Date('2026-10-08T10:00:00Z'),
  createdAt: new Date('2026-10-08T09:00:00Z'),
  updatedAt: new Date('2026-10-08T10:00:00Z'),
};

function service(session: unknown) {
  const manager = {
    getStatus: jest.fn(async () =>
      (session as any)?.status === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED',
    ),
    disconnect: jest.fn(async () => undefined),
  };
  const prisma = {
    waSession: { findUnique: jest.fn(async () => session) },
  };
  const svc = new WhatsappService(
    prisma as never,
    {} as never,
    manager as never,
  );
  return { svc, manager };
}

describe('WhatsappService.getIntegration', () => {
  it('maps a connected live session to a CONNECTED integration', async () => {
    const { svc } = service(liveSession);
    const integration = await svc.getIntegration('org_123');
    expect(integration?.status).toBe('CONNECTED');
    expect(integration?.organizationId).toBe('org_123');
    expect(integration?.displayPhoneNumber).toBe('919876543210');
  });

  it('returns null when the gym has no session row', async () => {
    const { svc } = service(null);
    await expect(svc.getIntegration('org_123')).resolves.toBeNull();
  });
});

describe('WhatsappService.completeEmbeddedSignup', () => {
  it('is gone: Meta onboarding was removed with the WA-AKG replacement', async () => {
    const { svc } = service(liveSession);
    await expect(svc.completeEmbeddedSignup()).rejects.toThrow(/removed|gone/i);
  });
});

describe('WhatsappService.disconnect', () => {
  it('unlinks through the manager', async () => {
    const { svc, manager } = service(liveSession);
    await expect(svc.disconnect('org_123')).resolves.toEqual({
      disconnected: true,
      credentialRemoved: false,
    });
    expect(manager.disconnect).toHaveBeenCalledWith('org_123');
  });
});
