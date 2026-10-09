import { NotFoundException } from '@nestjs/common';
import { BroadcastService } from './broadcast.service';

function service() {
  const prisma = {
    broadcast: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'b1',
        status: 'PENDING',
        ...args.data,
      })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'b1',
        ...args.data,
      })),
      findFirst: jest.fn(),
      findMany: jest.fn(async () => []),
    },
    file: {
      findFirst: jest.fn(async () => ({
        mimeType: 'image/jpeg',
        sizeBytes: 100,
      })),
    },
  };
  const segments = {
    getSegmentPhones: jest.fn(),
  };
  const communications = { sendAdHoc: jest.fn() };
  const whatsapp = { assertSendableImage: jest.fn() };
  const queue = { add: jest.fn(), remove: jest.fn() };
  const svc = new BroadcastService(
    prisma as never,
    segments as never,
    communications as never,
    whatsapp as never,
    queue as never,
    { emit: jest.fn() } as never,
  );
  return { svc, prisma, segments, communications, whatsapp, queue };
}

describe('BroadcastService.create', () => {
  it('skips members without phones and counts them', async () => {
    const { svc, segments, communications, prisma } = service();
    segments.getSegmentPhones.mockResolvedValue([
      { memberId: 'm1', phone: '+919876543210' },
      { memberId: 'm2', phone: null },
    ]);
    communications.sendAdHoc.mockResolvedValue({
      id: 'log1',
      status: 'PENDING',
      providerMessageId: 'waakg:queued:log1',
    });
    const out = await svc.create('o1', 'u1', { segmentId: 's1', text: 'Hi' });
    expect(out.queued).toBe(1);
    expect(prisma.broadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ total: 1, skipped: 1 }),
      }),
    );
    expect(communications.sendAdHoc).toHaveBeenCalledTimes(1);
  });

  it("narrows a branch-scoped sender's audience to their branch", async () => {
    const { svc, segments, communications } = service();
    segments.getSegmentPhones.mockResolvedValue([
      { memberId: 'm1', phone: '+919876543210' },
    ]);
    communications.sendAdHoc.mockResolvedValue({ id: 'log1' });
    await svc.create('o1', 'u1', { segmentId: 's1', text: 'Hi' }, 'br-1');
    expect(segments.getSegmentPhones).toHaveBeenCalledWith('o1', 's1', 'br-1');
  });

  it('keeps an org-wide sender unrestricted', async () => {
    const { svc, segments, communications } = service();
    segments.getSegmentPhones.mockResolvedValue([
      { memberId: 'm1', phone: '+919876543210' },
    ]);
    communications.sendAdHoc.mockResolvedValue({ id: 'log1' });
    await svc.create('o1', 'u1', { segmentId: 's1', text: 'Hi' });
    expect(segments.getSegmentPhones).toHaveBeenCalledWith('o1', 's1', null);
  });

  it('rejects a foreign segment with 404 and enqueues nothing', async () => {
    const { svc, segments, communications, prisma } = service();
    segments.getSegmentPhones.mockRejectedValue(new NotFoundException('nope'));
    await expect(
      svc.create('o1', 'u1', { segmentId: 'sx', text: 'Hi' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(communications.sendAdHoc).not.toHaveBeenCalled();
    expect(prisma.broadcast.create).not.toHaveBeenCalled();
  });

  it('rejects an empty audience with 400 and leaves no row', async () => {
    const { svc, segments, communications, prisma } = service();
    segments.getSegmentPhones.mockResolvedValue([
      { memberId: 'm1', phone: null },
    ]);
    await expect(
      svc.create('o1', 'u1', { segmentId: 's1', text: 'Hi' }),
    ).rejects.toThrow('no sendable members');
    expect(prisma.broadcast.create).not.toHaveBeenCalled();
    expect(communications.sendAdHoc).not.toHaveBeenCalled();
  });
});

describe('BroadcastService branch scope', () => {
  it("records a branch-scoped sender's branch on the row", async () => {
    const { svc, segments, communications, prisma } = service();
    segments.getSegmentPhones.mockResolvedValue([
      { memberId: 'm1', phone: '+919876543210' },
    ]);
    communications.sendAdHoc.mockResolvedValue({ id: 'log1' });
    await svc.create('o1', 'u1', { segmentId: 's1', text: 'Hi' }, 'br-1');
    expect(prisma.broadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ branchId: 'br-1' }),
      }),
    );
  });

  it("leaves an org-wide sender's row branchless", async () => {
    const { svc, segments, communications, prisma } = service();
    segments.getSegmentPhones.mockResolvedValue([
      { memberId: 'm1', phone: '+919876543210' },
    ]);
    communications.sendAdHoc.mockResolvedValue({ id: 'log1' });
    await svc.create('o1', 'u1', { segmentId: 's1', text: 'Hi' });
    expect(prisma.broadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ branchId: null }),
      }),
    );
  });

  it('lists only the caller branch for a branch-scoped caller', async () => {
    const { svc, prisma } = service();
    await svc.list('o1', 50, 'br-1');
    expect(prisma.broadcast.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'o1', branchId: 'br-1' },
      }),
    );
  });

  it('lists every row for an org-wide caller', async () => {
    const { svc, prisma } = service();
    await svc.list('o1', 50, null);
    expect(prisma.broadcast.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'o1' } }),
    );
  });

  it("404s another branch's broadcast on read", async () => {
    const { svc, prisma } = service();
    prisma.broadcast.findFirst.mockResolvedValue(null);
    await expect(svc.progress('o1', 'b1', 'br-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.broadcast.findFirst).toHaveBeenCalledWith({
      where: { id: 'b1', organizationId: 'o1', branchId: 'br-1' },
    });
  });

  it("404s another branch's broadcast on cancel and changes nothing", async () => {
    const { svc, prisma, queue } = service();
    prisma.broadcast.findFirst.mockResolvedValue(null);
    await expect(svc.cancel('o1', 'b1', 'br-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.broadcast.findFirst).toHaveBeenCalledWith({
      where: { id: 'b1', organizationId: 'o1', branchId: 'br-1' },
    });
    expect(prisma.broadcast.update).not.toHaveBeenCalled();
    expect(queue.remove).not.toHaveBeenCalled();
  });

  it('reads any row in the org for an org-wide caller', async () => {
    const { svc, prisma } = service();
    prisma.broadcast.findFirst.mockResolvedValue({ id: 'b1', branchId: null });
    await svc.progress('o1', 'b1');
    expect(prisma.broadcast.findFirst).toHaveBeenCalledWith({
      where: { id: 'b1', organizationId: 'o1' },
    });
  });
});
