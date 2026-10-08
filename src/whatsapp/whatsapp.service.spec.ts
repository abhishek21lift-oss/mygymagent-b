import { WhatsappService } from './whatsapp.service';

function service(session: unknown, configured = true) {
  const waAkg = {
    isConfigured: () => configured,
    // Mirrors the real provider: no session is visible when unconfigured.
    getSession: jest.fn().mockResolvedValue(configured ? session : null),
    performAction: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new WhatsappService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    waAkg as never,
  );
  return { svc, waAkg };
}

const connectedSession = {
  status: 'CONNECTED',
  me: { id: '919876543210@s.whatsapp.net' },
  pairingCode: null,
  qr: null,
};

describe('WhatsappService.getIntegration', () => {
  it('maps a connected WA-AKG session to a CONNECTED integration', async () => {
    const { svc } = service(connectedSession);
    const integration = await svc.getIntegration('org_123');
    expect(integration?.status).toBe('CONNECTED');
    expect(integration?.organizationId).toBe('org_123');
    expect(integration?.displayPhoneNumber).toBe('919876543210');
  });

  it('returns null when the gym has no WA-AKG session', async () => {
    const { svc } = service(null);
    await expect(svc.getIntegration('org_123')).resolves.toBeNull();
  });

  it('returns null when WA-AKG is not configured', async () => {
    const { svc } = service(connectedSession, false);
    await expect(svc.getIntegration('org_123')).resolves.toBeNull();
  });
});

describe('WhatsappService.completeEmbeddedSignup', () => {
  it('is gone: Meta onboarding was removed with the WA-AKG replacement', async () => {
    const { svc } = service(connectedSession);
    await expect(svc.completeEmbeddedSignup()).rejects.toThrow(/removed|gone/i);
  });
});
