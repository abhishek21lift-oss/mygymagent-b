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
    contactPicture: jest.fn(async () => 'https://pic'),
  };
  const prisma = {
    waSession: { findUnique: jest.fn(async () => session) },
    waContact: { findMany: jest.fn(async () => []) },
  };
  const svc = new WhatsappService(
    prisma as never,
    {} as never,
    manager as never,
  );
  return { svc, manager, prisma };
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

describe('WhatsappService.listContacts', () => {
  it('lists the session address book, empty when never linked', async () => {
    const { svc, prisma } = service(liveSession);
    (prisma.waContact.findMany as jest.Mock).mockResolvedValueOnce([
      { jid: '9198@s.whatsapp.net', name: 'Asha' },
    ]);
    await expect(svc.listContacts('org_123')).resolves.toEqual([
      { jid: '9198@s.whatsapp.net', name: 'Asha' },
    ]);
    const { svc: unlinked } = service(null);
    await expect(unlinked.listContacts('org_123')).resolves.toEqual([]);
  });
});

describe('WhatsappService.contactPicture', () => {
  it('returns the live picture URL', async () => {
    const { svc } = service(liveSession);
    await expect(
      svc.contactPicture('org_123', '9198@s.whatsapp.net'),
    ).resolves.toEqual({ url: 'https://pic' });
  });

  it('rejects non-chat JIDs', async () => {
    const { svc } = service(liveSession);
    await expect(svc.contactPicture('org_123', 'group@g.us')).rejects.toThrow(
      /JID/,
    );
  });
});
