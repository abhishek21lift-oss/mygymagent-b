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
});
