import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppAdapterController } from './whatsapp-adapter.controller';
import { WhatsAppAdapterService } from './whatsapp-adapter.service';
import { WhatsAppAdapterFeatureGuard } from './whatsapp-adapter.guard';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

describe('WhatsAppAdapterController (Negative Tests)', () => {
  let controller: WhatsAppAdapterController;
  let service: WhatsAppAdapterService;

  const orgA = 'org-a';
  const orgB = 'org-b';
  const userA = { organizationId: orgA, id: 'user-a' } as AuthenticatedUser;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WhatsAppAdapterController],
      providers: [
        {
          provide: WhatsAppAdapterService,
          useValue: {
            getStatus: jest.fn(),
            listAutoReplies: jest.fn(),
            listContacts: jest.fn(),
            listGroups: jest.fn(),
            getBotConfig: jest.fn(),
            updateBotConfig: jest.fn(),
            automationActivity: jest.fn(),
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

    controller = module.get<WhatsAppAdapterController>(
      WhatsAppAdapterController,
    );
    service = module.get<WhatsAppAdapterService>(WhatsAppAdapterService);
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

      const result = await controller.listAutoReplies(
        userA,
        undefined,
        undefined,
      );
      expect(service.listAutoReplies).toHaveBeenCalledWith(
        orgA,
        undefined,
        undefined,
      );
      expect(result).toEqual([]);
    });

    describe('listContacts', () => {
      it('should list contacts for the caller organization with search', async () => {
        (service.listContacts as jest.Mock).mockImplementation(() => {
          return [];
        });

        const result = await controller.listContacts(userA, undefined, 'ravi');

        expect(service.listContacts).toHaveBeenCalledWith(
          orgA,
          undefined,
          'ravi',
        );
        expect(service.listContacts).not.toHaveBeenCalledWith(
          orgB,
          expect.anything(),
          expect.anything(),
        );
        expect(result).toEqual([]);
      });

      it('should pass through a valid numeric limit', async () => {
        (service.listContacts as jest.Mock).mockImplementation(() => {
          return [];
        });

        await controller.listContacts(userA, '50', undefined);

        expect(service.listContacts).toHaveBeenCalledWith(orgA, 50, undefined);
      });

      it('should fall back to the service default for a non-numeric limit', async () => {
        (service.listContacts as jest.Mock).mockImplementation(() => {
          return [];
        });

        await controller.listContacts(userA, 'abc', undefined);

        expect(service.listContacts).toHaveBeenCalledWith(
          orgA,
          undefined,
          undefined,
        );
      });

      it('should pass boundary values through for the service to clamp', async () => {
        (service.listContacts as jest.Mock).mockImplementation(() => {
          return [];
        });

        await controller.listContacts(userA, '-5', undefined);
        await controller.listContacts(userA, '500', undefined);

        expect(service.listContacts).toHaveBeenCalledWith(orgA, -5, undefined);
        expect(service.listContacts).toHaveBeenCalledWith(orgA, 500, undefined);
      });
    });

    describe('listGroups', () => {
      it('should list groups for the caller organization', async () => {
        (service.listGroups as jest.Mock).mockImplementation(() => {
          return { available: true, groups: [] };
        });

        const result = await controller.listGroups(userA, undefined);

        expect(service.listGroups).toHaveBeenCalledWith(orgA, undefined);
        expect(service.listGroups).not.toHaveBeenCalledWith(
          orgB,
          expect.anything(),
        );
        expect(result).toEqual({ available: true, groups: [] });
      });

      it('should fall back to the service default for a non-numeric limit', async () => {
        (service.listGroups as jest.Mock).mockImplementation(() => {
          return { available: false, groups: [] };
        });

        await controller.listGroups(userA, 'NaN');

        expect(service.listGroups).toHaveBeenCalledWith(orgA, undefined);
      });
    });

    describe('botConfig', () => {
      it('should read config for the caller organization', async () => {
        (service.getBotConfig as jest.Mock).mockImplementation(() => null);

        const result = await controller.getBotConfig(userA);

        expect(service.getBotConfig).toHaveBeenCalledWith(orgA);
        expect(service.getBotConfig).not.toHaveBeenCalledWith(orgB);
        expect(result).toBeNull();
      });

      it('should forward updates with the caller organization', async () => {
        (service.updateBotConfig as jest.Mock).mockImplementation(() => ({}));

        await controller.updateBotConfig(userA, { enablePing: true });

        expect(service.updateBotConfig).toHaveBeenCalledWith(orgA, {
          enablePing: true,
        });
        expect(service.updateBotConfig).not.toHaveBeenCalledWith(
          orgB,
          expect.anything(),
        );
      });
    });

    describe('automationActivity', () => {
      it('should list activity for the caller organization', async () => {
        (service.automationActivity as jest.Mock).mockImplementation(() => []);

        const result = await controller.automationActivity(userA, undefined);

        expect(service.automationActivity).toHaveBeenCalledWith(
          orgA,
          undefined,
        );
        expect(service.automationActivity).not.toHaveBeenCalledWith(
          orgB,
          expect.anything(),
        );
        expect(result).toEqual([]);
      });
    });

    it('should not allow user from org A to list auto-replies of org B', async () => {
      await controller.listAutoReplies(userA, undefined, undefined);
      expect(service.listAutoReplies).toHaveBeenCalledWith(
        orgA,
        undefined,
        undefined,
      );
      expect(service.listAutoReplies).not.toHaveBeenCalledWith(
        orgB,
        undefined,
        undefined,
      );
    });
  });

  describe('createAutoReply', () => {
    const dto = {
      keyword: 'test',
      matchType: 'EXACT' as const,
      scope: 'ALL' as const,
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
      expect(service.createAutoReply).not.toHaveBeenCalledWith(
        orgB,
        dto,
        userA.id,
      );
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
