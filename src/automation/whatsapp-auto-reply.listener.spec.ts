import { WhatsappAutoReplyListener } from './whatsapp-auto-reply.listener';

const gym = {
  id: 'org_1',
  name: 'Test Gym',
  timezone: 'Asia/Kolkata',
  currency: 'INR',
};

function listener(linked: boolean) {
  const sendAdHoc = jest.fn().mockResolvedValue({ id: 'log_1' });
  const communications = {
    ownWhatsappNumberLinked: jest.fn().mockResolvedValue(linked),
    sendAdHoc,
    renderForOrganization: jest.fn(async (_org: string, text: string) => text),
  };
  const prisma = {
    inboundMessage: {
      findUnique: jest.fn().mockResolvedValue({ body: 'hello' }),
    },
    organization: { findFirst: jest.fn().mockResolvedValue(gym) },
    messageLog: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    whatsappWebSession: {
      findUnique: jest.fn().mockResolvedValue({ autoReply: true }),
    },
    botOptOut: { findUnique: jest.fn().mockResolvedValue(null) },
    autoReplyRule: { findMany: jest.fn().mockResolvedValue([]) },
    botConfig: { findUnique: jest.fn().mockResolvedValue(null) },
    waSession: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const config = { get: jest.fn().mockReturnValue('http://localhost:3000') };
  const svc = new WhatsappAutoReplyListener(
    prisma as never,
    communications as never,
    config as never,
  );
  return { svc, sendAdHoc, prisma, communications };
}

const event = {
  organizationId: 'org_1',
  inboundMessageId: 'in_1',
  from: '919876543210',
  matchedMemberId: null,
};

describe('WhatsappAutoReplyListener', () => {
  it('answers a greeting with the menu when the number is linked', async () => {
    const { svc, sendAdHoc } = listener(true);
    const intent = await svc.reply(event as never);
    expect(intent).toBe('MENU');
    expect(sendAdHoc).toHaveBeenCalledWith(
      expect.objectContaining({ templateKey: 'auto_reply.menu' }),
    );
  });

  it('stays silent when no number is linked', async () => {
    const { svc, sendAdHoc } = listener(false);
    await expect(svc.reply(event as never)).resolves.toBeNull();
    expect(sendAdHoc).not.toHaveBeenCalled();
  });
});

function botListener(config: object, body: string) {
  const ctx = listener(true);
  (ctx.prisma.botConfig.findUnique as jest.Mock).mockResolvedValue(config);
  (ctx.prisma.inboundMessage.findUnique as jest.Mock).mockResolvedValue({
    body,
  });
  return ctx;
}

describe('WhatsappAutoReplyListener bot config', () => {
  const base = {
    prefix: '#',
    enablePing: false,
    enableUptime: false,
    welcomeMessage: null,
  };
  const noBotKey = expect.objectContaining({
    templateKey: expect.stringMatching(/^auto_reply\.bot_/),
  });

  it('sends no bot reply with no BotConfig row', async () => {
    const { svc, sendAdHoc } = botListener(null as never, '#ping');
    await svc.reply({ ...event, isGroup: false } as never);
    expect(sendAdHoc).not.toHaveBeenCalledWith(noBotKey);
  });

  it('answers #ping when enabled', async () => {
    const { svc, sendAdHoc } = botListener(
      { ...base, enablePing: true },
      '#ping',
    );
    await expect(
      svc.reply({ ...event, isGroup: false } as never),
    ).resolves.toBe('BOT_PING');
    expect(sendAdHoc).toHaveBeenCalledWith(
      expect.objectContaining({ templateKey: 'auto_reply.bot_ping' }),
    );
  });

  it('ignores #ping when disabled', async () => {
    const { svc, sendAdHoc } = botListener(base, '#ping');
    await svc.reply({ ...event, isGroup: false } as never);
    expect(sendAdHoc).not.toHaveBeenCalledWith(noBotKey);
  });

  it('defers to staff keyword rules over bot commands', async () => {
    const ctx = botListener({ ...base, enablePing: true }, '#ping');
    (ctx.prisma.autoReplyRule.findMany as jest.Mock).mockResolvedValue([
      {
        keyword: 'ping',
        matchType: 'CONTAINS',
        scope: 'ALL',
        enabled: true,
        priority: 0,
      },
    ]);
    await expect(
      ctx.svc.reply({ ...event, isGroup: false } as never),
    ).resolves.toBeNull();
    expect(ctx.sendAdHoc).not.toHaveBeenCalled();
  });

  it('answers uptime from the linked session', async () => {
    const ctx = botListener({ ...base, enableUptime: true }, '#uptime');
    (ctx.prisma.waSession.findUnique as jest.Mock).mockResolvedValue({
      status: 'CONNECTED',
      connectedAt: new Date('2024-01-01T00:00:00Z'),
    });
    await expect(
      ctx.svc.reply({ ...event, isGroup: false } as never),
    ).resolves.toBe('BOT_UPTIME');
    expect(ctx.sendAdHoc).toHaveBeenCalledWith(
      expect.objectContaining({ templateKey: 'auto_reply.bot_uptime' }),
    );
  });

  it('stays silent on uptime when disconnected', async () => {
    const ctx = botListener({ ...base, enableUptime: true }, '#uptime');
    (ctx.prisma.waSession.findUnique as jest.Mock).mockResolvedValue({
      status: 'DISCONNECTED',
      connectedAt: null,
    });
    await ctx.svc.reply({ ...event, isGroup: false } as never);
    expect(ctx.sendAdHoc).not.toHaveBeenCalledWith(noBotKey);
  });

  it('welcomes first contact once, never again', async () => {
    const ctx = botListener(
      { ...base, welcomeMessage: 'Welcome!' },
      'hello there',
    );
    await expect(
      ctx.svc.reply({ ...event, isGroup: false } as never),
    ).resolves.toBe('BOT_WELCOME');
    expect(ctx.sendAdHoc).toHaveBeenCalledTimes(1);
    // Retried or repeated contact: the welcome log now exists, so the
    // greeting never resends (a 'thanks' ends silently via gym intents).
    (ctx.prisma.messageLog.findFirst as jest.Mock).mockResolvedValue({
      id: 'log_9',
    });
    (ctx.prisma.inboundMessage.findUnique as jest.Mock).mockResolvedValue({
      body: 'thanks',
    });
    await expect(
      ctx.svc.reply({ ...event, isGroup: false } as never),
    ).resolves.toBeNull();
    expect(
      ctx.sendAdHoc.mock.calls.filter(([input]: any) =>
        String(input.templateKey).startsWith('auto_reply.bot_'),
      ),
    ).toHaveLength(1);
  });
});
