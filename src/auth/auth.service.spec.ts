import { AuthService } from './auth.service';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TokensService } from './tokens.service';
import { CommunicationsService } from '../communications/communications.service';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../rbac/permissions.service';

describe('AuthService (basic)', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: {} },
        { provide: TokensService, useValue: {} },
        { provide: CommunicationsService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: PermissionsService, useValue: {} },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
