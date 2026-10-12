import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppAdapterController } from './whatsapp-adapter.controller';
import { WhatsAppAdapterService } from './whatsapp-adapter.service';
import { WhatsAppAdapterFeatureGuard } from './whatsapp-adapter.guard';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

describe('WhatsAppAdapterController', () => {
  let controller: WhatsAppAdapterController;
  let service: WhatsAppAdapterService;

  const mockUser = {
    organizationId: 'org-123',
    id: 'user-1',
  } as AuthenticatedUser;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WhatsAppAdapterController],
      providers: [
        {
          provide: WhatsAppAdapterService,
          useValue: {
            getStatus: jest.fn(),
            listAutoReplies: jest.fn(),
            createAutoReply: jest.fn(),
            updateAutoReply: jest.fn(),
            deleteAutoReply: jest.fn(),
          },
        },
        {
          provide: WhatsAppAdapterFeatureGuard,
          useValue: {
            canActivate: () => true,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key, defaultValue) => {
              if (key === 'WHATSAPP_ADAPTER_ENABLED') return true;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    controller = module.get<WhatsAppAdapterController>(
      WhatsAppAdapterController,
    );
    service = module.get<WhatsAppAdapterService>(WhatsAppAdapterService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getStatus', () => {
    it('should call service.getStatus with user organizationId', async () => {
      const expected = { status: 'CONNECTED' };
      (service.getStatus as jest.Mock).mockResolvedValue(expected);

      const result = await controller.getStatus(mockUser);

      expect(service.getStatus).toHaveBeenCalledWith('org-123');
      expect(result).toEqual(expected);
    });
  });
});
