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

describe('sendAdHoc body persistence', () => {
  it('persists the rendered body on the log row', async () => {
    const create = jest.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'log1',
      ...args.data,
    }));
    const prisma = {
      organization: {
        findUnique: async () => ({ name: 'Cult Gym' }),
      },
      messageLog: {
        create,
        update: jest.fn(
          async (args: { data: Record<string, unknown> }) => args.data,
        ),
      },
    };
    const templates = {
      render: (text: string, vars: Record<string, string>) =>
        text.replace('{{organizationName}}', vars.organizationName ?? ''),
    };
    const whatsapp = { send: jest.fn(async () => undefined) };
    const svc = new CommunicationsService(
      prisma as never,
      templates as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      {} as never,
      whatsapp as never,
      {} as never,
      {} as never,
      { getStatus: jest.fn() } as never,
    );
    await svc.sendAdHoc({
      organizationId: 'o1',
      channel: 'WHATSAPP',
      category: 'TRANSACTIONAL',
      recipient: '+919876543210',
      body: 'Hi {{organizationName}}',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ body: 'Hi Cult Gym' }),
      }),
    );
  });
});
