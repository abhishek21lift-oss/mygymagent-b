import { CommunicationsService } from './communications.service';

function service(status: string | null) {
  const sessions = {
    getStatus: jest.fn(async () => status ?? 'DISCONNECTED'),
  };
  const prisma = {};
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const svc = new CommunicationsService(
    prisma as never,
    {} as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    sessions as never,
  );
  return { svc, sessions };
}

describe('CommunicationsService.ownWhatsappNumberLinked', () => {
  it('is true with a connected live session', async () => {
    const { svc } = service('CONNECTED');
    await expect(svc.ownWhatsappNumberLinked('org_1')).resolves.toBe(true);
  });

  it('is false without a live session', async () => {
    const { svc } = service(null);
    await expect(svc.ownWhatsappNumberLinked('org_1')).resolves.toBe(false);
  });
});

describe('CommunicationsService.whatsappReadiness', () => {
  it('is false when nothing is linked', async () => {
    const { svc } = service('DISCONNECTED');
    await expect(svc.whatsappReadiness('org_1')).resolves.toBe(false);
  });

  it('is ready with a connected session, toggle or not', async () => {
    const { svc } = service('CONNECTED');
    await expect(svc.whatsappReadiness('org_1')).resolves.toBe(true);
  });
});
