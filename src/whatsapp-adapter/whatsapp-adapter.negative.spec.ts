import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppAdapterController } from './whatsapp-adapter.controller';
import { WhatsAppAdapterService } from './whatsapp-adapter.service';
import { WhatsAppAdapterFeatureGuard } from './whatsapp-adapter.guard';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

describe('WhatsAppAdapterController (Negative Tests)', () => {
  let controller: WhatsAppAdapterController;
  let service: WhatsAppAdapterService;
  let configService: ConfigService;

  const orgA = 'org-a';
  const orgB = 'org-b';
  const userA = { organizationId: orgA, id: 'user-a' } as AuthenticatedUser;
  const userB = { organizationId: orgB, id: 'user-b' } as AuthenticatedUser;

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
          useClass: WhatsAppAdapterFeatureGuard,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key, defaultValue) => {
              if (key === 'WHATSAPP_ADAPTER_ENABLED') return true; // allow access by default in these tests
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    controller = module.get<WhatsAppAdapterController>(WhatsAppAdapterController);
    service = module.get<WhatsAppAdapterService>(WhatsAppAdapterService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('getStatus', () => {
    it('should return 404 if no session exists for the organization', async () => {
      (service.getStatus as jest.Mock).mockImplementation(() => {
        return {
          status: 'NOT_CONNECTED',
          phoneNumber: null,
          displayPhoneNumber: null,
          qrDataUrl: null,
          pairingCode: null,
          connectedAt: null,
          createdAt: null,
          updatedAt: null,
        };
      });

      const result = await controller.getStatus(userA);
      expect(service.getStatus).toHaveBeenCalledWith(orgA);
      expect(result.status).toBe('NOT_CONNECTED');
    });

    it('should not allow user from org A to get status of org B', async () => {
      await controller.getStatus(userA);
      expect(service.getStatus).toHaveBeenCalledWith(orgA);
      expect(service.getStatus).not.toHaveBeenCalledWith(orgB);
    });
  });

  describe('listAutoReplies', () => {
    it('should return empty list when no auto-replies exist for the organization', async () => {
      (service.listAutoReplies as jest.Mock).mockImplementation(() => {
        return [];
      });

      const result = await controller.listAutoReplies(userA, undefined, undefined);
      expect(service.listAutoReplies).toHaveBeenCalledWith(orgA, undefined, undefined);
      expect(result).toEqual([]);
    });

    it('should not allow user from org A to list auto-replies of org B', async () => {
      await controller.listAutoReplies(userA, undefined, undefined);
      expect(service.listAutoReplies).toHaveBeenCalledWith(orgA, undefined, undefined);
      expect(service.listAutoReplies).not.toHaveBeenCalledWith(orgB, undefined, undefined);
    });
  });

  describe('createAutoReply', () => {
    const dto = {
      keyword: 'test',
      matchType: 'EXACT',
      scope: 'ALL',
      answer: 'test answer',
    };

    it('should create auto-reply for the correct organization', async () => {
      (service.createAutoReply as jest.Mock).mockImplementation(() => {
        return {};
      });

      await controller.createAutoReply(userA, dto);
      expect(service.createAutoReply).toHaveBeenCalledWith(orgA, dto, userA.id);
    });

    it('should not allow user from org A to create auto-reply for org B', async () => {
      await controller.createAutoReply(userA, dto);
      expect(service.createAutoReply).toHaveBeenCalledWith(orgA, dto, userA.id);
      expect(service.createAutoReply).not.toHaveBeenCalledWith(orgB, dto, userA.id);
    });
  });

  describe('updateAutoReply', () => {
    const dto = {
      keyword: 'updated',
    };
    const id = 'some-id';

    it('should update auto-reply for the correct organization', async () => {
      (service.updateAutoReply as jest.Mock).mockImplementation(() => {
        return {};
      });

      await controller.updateAutoReply(userA, id, dto);
      expect(service.updateAutoReply).toHaveBeenCalledWith(orgA, id, dto);
    });

    it('should not allow user from org A to update auto-reply of org B', async () => {
      await controller.updateAutoReply(userA, id, dto);
      expect(service.updateAutoReply).toHaveBeenCalledWith(orgA, id, dto);
      expect(service.updateAutoReply).not.toHaveBeenCalledWith(orgB, id, dto);
    });
  });

  describe('deleteAutoReply', () => {
    const id = 'some-id';

    it('should delete auto-reply for the correct organization', async () => {
      (service.deleteAutoReply as jest.Mock).mockImplementation(() => {
        return {};
      });

      await controller.deleteAutoReply(userA, id);
      expect(service.deleteAutoReply).toHaveBeenCalledWith(orgA, id);
    });

    it('should not allow user from org A to delete auto-reply of org B', async () => {
      await controller.deleteAutoReply(userA, id);
      expect(service.deleteAutoReply).toHaveBeenCalledWith(orgA, id);
      expect(service.deleteAutoReply).not.toHaveBeenCalledWith(orgB, id);
    });
  });
});
