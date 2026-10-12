import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppAdapterService } from './whatsapp-adapter.service';
import { PrismaService } from '../prisma/prisma.service';
import { WaSessionManager } from '../whatsapp-web/wa-session.manager';

describe('WhatsAppAdapterService', () => {
  let service: WhatsAppAdapterService;
  let prismaService: PrismaService;
  let waSessionManager: WaSessionManager;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppAdapterService,
        {
          provide: PrismaService,
          useValue: {
            waSession: {
              findUnique: jest.fn(),
            },
            waContact: {
              findMany: jest.fn(),
            },
            messageLog: {
              findMany: jest.fn(),
            },
            botConfig: {
              findUnique: jest.fn(),
              upsert: jest.fn(),
            },
            autoReplyRule: {
              findMany: jest.fn(),
              create: jest.fn(),
              updateMany: jest.fn(),
              deleteMany: jest.fn(),
            },
          },
        },
        {
          provide: WaSessionManager,
          useValue: {
            getStatus: jest.fn(),
            codes: jest.fn(),
            listGroups: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WhatsAppAdapterService>(WhatsAppAdapterService);
    prismaService = module.get<PrismaService>(PrismaService);
    waSessionManager = module.get<WaSessionManager>(WaSessionManager);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getStatus', () => {
    it('should return NOT_CONNECTED when no session exists', async () => {
      const organizationId = 'org-123';
      (waSessionManager.getStatus as jest.Mock).mockResolvedValue(
        'DISCONNECTED',
      );
      (prismaService.waSession.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.getStatus(organizationId);

      expect(result).toEqual({
        status: 'NOT_CONNECTED',
        phoneNumber: null,
        displayPhoneNumber: null,
        qrDataUrl: null,
        pairingCode: null,
        connectedAt: null,
        createdAt: null,
        updatedAt: null,
        lastError: null,
      });
    });
  });

  describe('listContacts', () => {
    it('should return [] when the organization has no session', async () => {
      (prismaService.waSession.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.listContacts('org-123');

      expect(result).toEqual([]);
      expect(prismaService.waContact.findMany).not.toHaveBeenCalled();
    });

    it('should scope by session and apply case-insensitive search', async () => {
      (prismaService.waSession.findUnique as jest.Mock).mockResolvedValue({
        id: 'sess-1',
      });
      (prismaService.waContact.findMany as jest.Mock).mockResolvedValue([]);

      await service.listContacts('org-123', 50, 'ravi');

      expect(prismaService.waSession.findUnique).toHaveBeenCalledWith({
        where: { organizationId: 'org-123' },
        select: { id: true },
      });
      expect(prismaService.waContact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ sessionId: 'sess-1' }),
          take: 50,
        }),
      );
      const where = (prismaService.waContact.findMany as jest.Mock).mock
        .calls[0][0].where;
      expect(JSON.stringify(where)).toContain('ravi');
    });

    it('should clamp take to the [1, 200] range', async () => {
      (prismaService.waSession.findUnique as jest.Mock).mockResolvedValue({
        id: 'sess-1',
      });
      (prismaService.waContact.findMany as jest.Mock).mockResolvedValue([]);

      await service.listContacts('org-123', 500);
      expect(
        (prismaService.waContact.findMany as jest.Mock).mock.calls[0][0].take,
      ).toBe(200);

      await service.listContacts('org-123', -5);
      expect(
        (prismaService.waContact.findMany as jest.Mock).mock.calls[1][0].take,
      ).toBe(1);
    });
  });

  describe('listGroups', () => {
    it('should report unavailable when the session manager has no groups', async () => {
      (waSessionManager.listGroups as jest.Mock).mockResolvedValue(null);

      const result = await service.listGroups('org-123');

      expect(waSessionManager.listGroups).toHaveBeenCalledWith('org-123');
      expect(result).toEqual({ available: false, groups: [] });
    });

    it('should return available groups honoring the limit', async () => {
      (waSessionManager.listGroups as jest.Mock).mockResolvedValue([
        { jid: 'a@g.us', subject: 'A', participantCount: 3 },
        { jid: 'b@g.us', subject: 'B', participantCount: 5 },
        { jid: 'c@g.us', subject: 'C', participantCount: 1 },
      ]);

      const result = await service.listGroups('org-123', 2);

      expect(result).toEqual({
        available: true,
        groups: [
          { jid: 'a@g.us', subject: 'A', participantCount: 3 },
          { jid: 'b@g.us', subject: 'B', participantCount: 5 },
        ],
      });
    });
  });

  describe('botConfig', () => {
    it('should return null when no row exists (all behaviors off)', async () => {
      (prismaService.botConfig.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.getBotConfig('org-123');

      expect(prismaService.botConfig.findUnique).toHaveBeenCalledWith({
        where: { organizationId: 'org-123' },
      });
      expect(result).toBeNull();
    });

    it('should upsert whitelisted fields only', async () => {
      (prismaService.botConfig.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg-1',
      });

      await service.updateBotConfig('org-123', {
        prefix: '!',
        enablePing: true,
      });

      expect(prismaService.botConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-123' },
          create: expect.objectContaining({
            organizationId: 'org-123',
            prefix: '!',
            enablePing: true,
            enableUptime: false,
            welcomeMessage: null,
          }),
        }),
      );
    });

    it('should reject a blank prefix and an empty patch', async () => {
      await expect(
        service.updateBotConfig('org-123', { prefix: '   ' }),
      ).rejects.toThrow('prefix must be 1 to 3 characters');
      await expect(service.updateBotConfig('org-123', {})).rejects.toThrow(
        'nothing to update',
      );
      expect(prismaService.botConfig.upsert).not.toHaveBeenCalled();
    });

    it('should clear the welcome message on blank input', async () => {
      (prismaService.botConfig.upsert as jest.Mock).mockResolvedValue({
        id: 'cfg-1',
      });

      await service.updateBotConfig('org-123', { welcomeMessage: '  ' });

      expect(prismaService.botConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ welcomeMessage: null }),
        }),
      );
    });
  });

  describe('automationActivity', () => {
    it('should list only automatic answers for the organization', async () => {
      (prismaService.messageLog.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.automationActivity('org-123', 20);

      expect(prismaService.messageLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org-123',
            channel: 'WHATSAPP',
          }),
          take: 20,
        }),
      );
      const where = (prismaService.messageLog.findMany as jest.Mock).mock
        .calls[0][0].where;
      expect(where.templateKey).toEqual({ startsWith: 'auto_reply.' });
      expect(result).toEqual([]);
    });
  });
});
