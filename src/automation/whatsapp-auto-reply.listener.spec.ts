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
  };
  const prisma = {
    inboundMessage: {
      findUnique: jest.fn().mockResolvedValue({ body: 'hello' }),
    },
    organization: { findFirst: jest.fn().mockResolvedValue(gym) },
    messageLog: { findMany: jest.fn().mockResolvedValue([]) },
    whatsappWebSession: {
      findUnique: jest.fn().mockResolvedValue({ autoReply: true }),
    },
  };
  const config = { get: jest.fn().mockReturnValue('http://localhost:3000') };
  const svc = new WhatsappAutoReplyListener(
    prisma as never,
    communications as never,
    config as never,
  );
  return { svc, sendAdHoc };
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
