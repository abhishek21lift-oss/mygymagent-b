import {
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { GatewayWebhookService } from './gateway-webhook.service';

const SECRET = 'test-webhook-secret-1234';

function harness(orgRow: unknown = { id: 'org1' }) {
  const config = {
    get: (key: string) =>
      key === 'WA_GATEWAY_WEBHOOK_SECRET' ? SECRET : undefined,
  };
  const prisma = {
    organization: { findUnique: jest.fn(async () => orgRow) },
    messageLog: { updateMany: jest.fn(async () => ({ count: 1 })) },
    waSession: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const filer = {
    file: jest.fn(async () => ({ id: 'in-1' })),
    fileGroup: jest.fn(async () => ({ id: 'in-2' })),
  };
  const service = new GatewayWebhookService(
    config as never,
    prisma as never,
    filer as never,
  );
  return { service, prisma, filer };
}

function writes(prisma: { messageLog: { updateMany: jest.Mock }; waSession: { updateMany: jest.Mock }; organization: { findUnique: jest.Mock } }, filer: { file: jest.Mock; fileGroup: jest.Mock }) {
  return [
    prisma.organization.findUnique,
    prisma.messageLog.updateMany,
    prisma.waSession.updateMany,
    filer.file,
    filer.fileGroup,
  ];
}

function signed(
  event: string,
  sessionId: string,
  data: unknown,
  opts: { timestamp?: string; secret?: string } = {},
) {
  const payload = {
    event,
    sessionId,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    data,
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const sig =
    'sha256=' +
    createHmac('sha256', opts.secret ?? SECRET).update(raw).digest('hex');
  return { raw, sig };
}

const receivedData = {
  key: {
    id: 'MSG1',
    remoteJid: '919876543210@s.whatsapp.net',
    fromMe: false,
  },
  pushName: 'Ravi',
  messageTimestamp: 1728567890,
  from: '919876543210@s.whatsapp.net',
  receiver: '911234567890@s.whatsapp.net',
  sender: '919876543210@s.whatsapp.net',
  isGroup: false,
  chatType: 'PERSONAL',
  type: 'TEXT',
  content: 'hello gym',
  fileUrl: null,
  caption: '',
  quoted: null,
};

describe('GatewayWebhookService', () => {
  it('rejects bad signature with 401 and writes nothing', async () => {
    const { service, prisma, filer } = harness();
    const { raw } = signed(
      'message.received',
      'gym-org1',
      receivedData,
      { secret: 'wrong-secret-0000000000' },
    );
    await expect(service.handle(raw, 'sha256=deadbeef')).rejects.toThrow(
      UnauthorizedException,
    );
    for (const mock of writes(prisma, filer)) expect(mock).not.toHaveBeenCalled();
  });

  it('rejects timestamps older than 5 minutes (replay)', async () => {
    const { service, prisma, filer } = harness();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { raw, sig } = signed('message.received', 'gym-org1', receivedData, {
      timestamp: stale,
    });
    await expect(service.handle(raw, sig)).rejects.toThrow(
      UnauthorizedException,
    );
    for (const mock of writes(prisma, filer)) expect(mock).not.toHaveBeenCalled();
  });

  it('message.received files an InboundMessage via the shared filer', async () => {
    const { service, prisma, filer } = harness();
    const { raw, sig } = signed('message.received', 'gym-org1', receivedData);
    await expect(service.handle(raw, sig)).resolves.toEqual({
      received: true,
    });
    expect(prisma.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org1' },
    });
    expect(filer.file).toHaveBeenCalledWith(
      'org1',
      '919876543210',
      'hello gym',
      'Ravi',
    );
    expect(filer.fileGroup).not.toHaveBeenCalled();
  });

  it('message.status advances SENT→DELIVERED→READ, never backwards', async () => {
    const { service, prisma } = harness();
    const status = (s: string) =>
      signed('message.status', 'gym-org1', {
        keyId: 'ABC123',
        remoteJid: '919876543210@s.whatsapp.net',
        status: s,
      });

    const delivered = status('DELIVERED');
    await service.handle(delivered.raw, delivered.sig);
    expect(prisma.messageLog.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org1',
        providerMessageId: 'waakg-gw:ABC123',
        status: { in: ['SENT'] },
      },
      data: { status: 'DELIVERED' },
    });

    prisma.messageLog.updateMany.mockClear();
    const read = status('READ');
    await service.handle(read.raw, read.sig);
    expect(prisma.messageLog.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org1',
        providerMessageId: 'waakg-gw:ABC123',
        status: { in: ['SENT', 'DELIVERED'] },
      },
      data: { status: 'READ' },
    });

    // A PENDING report can never move a row backwards: zero writes.
    prisma.messageLog.updateMany.mockClear();
    const pending = status('PENDING');
    await expect(service.handle(pending.raw, pending.sig)).resolves.toEqual({
      received: true,
    });
    expect(prisma.messageLog.updateMany).not.toHaveBeenCalled();
  });

  it('unknown sessionId slug → 404, writes nothing', async () => {
    const { service, prisma, filer } = harness(null);
    const { raw, sig } = signed('message.status', 'gym-no-such-org', {
      keyId: 'ABC123',
      remoteJid: '919876543210@s.whatsapp.net',
      status: 'DELIVERED',
    });
    await expect(service.handle(raw, sig)).rejects.toThrow(NotFoundException);
    expect(prisma.messageLog.updateMany).not.toHaveBeenCalled();
    expect(prisma.waSession.updateMany).not.toHaveBeenCalled();
    expect(filer.file).not.toHaveBeenCalled();
    expect(filer.fileGroup).not.toHaveBeenCalled();
  });

  it('message.received in a group files via fileGroup with the sender digits', async () => {
    const { service, filer } = harness();
    const { raw, sig } = signed('message.received', 'gym-org1', {
      ...receivedData,
      key: {
        id: 'MSG2',
        remoteJid: '120363012345@g.us',
        fromMe: false,
        participant: '919876543210@s.whatsapp.net',
      },
      from: '120363012345@g.us',
      sender: '919876543210@s.whatsapp.net',
      isGroup: true,
      chatType: 'GROUP',
    });
    await expect(service.handle(raw, sig)).resolves.toEqual({
      received: true,
    });
    expect(filer.fileGroup).toHaveBeenCalledWith(
      'org1',
      '120363012345@g.us',
      '919876543210',
      'hello gym',
      'Ravi',
    );
    expect(filer.file).not.toHaveBeenCalled();
  });
});
