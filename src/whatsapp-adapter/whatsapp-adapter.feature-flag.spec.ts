import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppAdapterFeatureGuard } from './whatsapp-adapter.guard';
import { ConfigService } from '@nestjs/config';

describe('WhatsAppAdapterFeatureGuard', () => {
  let guard: WhatsAppAdapterFeatureGuard;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppAdapterFeatureGuard,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key, defaultValue) => {
              if (key === 'WHATSAPP_ADAPTER_ENABLED') return true; // default to enabled
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<WhatsAppAdapterFeatureGuard>(
      WhatsAppAdapterFeatureGuard,
    );
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('should return true when feature is enabled', async () => {
    (configService.get as jest.Mock).mockImplementation((key, defaultValue) => {
      if (key === 'WHATSAPP_ADAPTER_ENABLED') return true;
      return defaultValue;
    });

    const canActivate = await guard.canActivate(null as any);
    expect(canActivate).toBe(true);
  });

  it('should return false when feature is disabled', async () => {
    (configService.get as jest.Mock).mockImplementation((key, defaultValue) => {
      if (key === 'WHATSAPP_ADAPTER_ENABLED') return false;
      return defaultValue;
    });

    const canActivate = await guard.canActivate(null as any);
    expect(canActivate).toBe(false);
  });
});
