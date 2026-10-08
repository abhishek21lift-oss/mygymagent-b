import { CommunicationsService } from './communications.service';

function service(session: unknown, prefs: unknown) {
  const waAkg = {
    getSession: jest.fn().mockResolvedValue(session),
  };
  const prisma = {
    whatsappWebSession: { findUnique: jest.fn().mockResolvedValue(prefs) },
    whatsappIntegration: {
      findUnique: jest.fn().mockResolvedValue({ status: 'CONNECTED' }),
    },
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const svc = new CommunicationsService(
    prisma as never,
    {} as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    waAkg as never,
  );
  return { svc, waAkg, prisma };
}

const connected = { status: 'CONNECTED', me: { id: '9198@s.whatsapp.net' } };

describe('CommunicationsService.ownWhatsappNumberLinked', () => {
  it('is true with a connected WA-AKG session and no feature flag', async () => {
    const { svc } = service(connected, null);
    await expect(svc.ownWhatsappNumberLinked('org_1')).resolves.toBe(true);
  });

  it('is false without a WA-AKG session', async () => {
    const { svc } = service(null, null);
    await expect(svc.ownWhatsappNumberLinked('org_1')).resolves.toBe(false);
  });
});

describe('CommunicationsService.whatsappReadiness', () => {
  it('ignores the dead Meta integration row: WA-AKG session decides', async () => {
    const { svc } = service(null, null);
    await expect(svc.whatsappReadiness('org_1')).resolves.toBe(false);
  });

  it('is ready with a connected session opted into sending', async () => {
    const { svc } = service(connected, { useForSending: true });
    await expect(svc.whatsappReadiness('org_1')).resolves.toBe(true);
  });
});
