import { AuthService } from './auth.service';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TokensService } from './tokens.service';
import { CommunicationsService } from '../communications/communications.service';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../rbac/permissions.service';
import { MfaPolicyService } from './mfa/mfa-policy.service';
import { MfaService } from './mfa/mfa.service';
import { MemberOtpService } from './member-otp.service';

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
        { provide: MfaService, useValue: {} },
        { provide: MfaPolicyService, useValue: {} },
        { provide: MemberOtpService, useValue: {} },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

describe('AuthService session endings', () => {
  function build() {
    const tx = {
      user: { update: jest.fn() },
      refreshToken: { updateMany: jest.fn() },
      passwordResetToken: { updateMany: jest.fn() },
    };
    const prisma = {
      passwordResetToken: {
        findUnique: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      user: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    const tokens = {
      signAccessToken: jest.fn(() => 'access'),
      issueRefreshToken: jest.fn(async () => ({
        token: 'refresh',
        expiresAt: new Date(),
      })),
      rotateRefreshToken: jest.fn(),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const service = new AuthService(
      prisma as never,
      tokens as never,
      {} as never,
      audit as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma, tx, tokens };
  }

  it('a password reset ends every session and kills other reset links', async () => {
    const { service, prisma, tx } = build();
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 'prt-1',
      userId: 'user-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.user.findUniqueOrThrow.mockResolvedValue({ status: 'ACTIVE' });

    await service.resetPassword('token', 'a-new-password-123');

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { tokenVersion: { increment: 1 } },
    });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
  });

  it('signs a refreshed access token with the current token version', async () => {
    const { service, prisma, tokens } = build();
    tokens.rotateRefreshToken.mockResolvedValue({
      reused: false,
      userId: 'user-1',
      token: 'next',
      expiresAt: new Date(),
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      organizationId: 'org-1',
      email: 'a@example.com',
      firstName: 'A',
      lastName: 'B',
      status: 'ACTIVE',
      deletedAt: null,
      primaryBranchId: null,
      emailVerifiedAt: null,
      tokenVersion: 4,
      member: null,
      organization: { status: 'ACTIVE', deletedAt: null },
    });

    await service.refresh('refresh', {});

    expect(tokens.signAccessToken).toHaveBeenCalledWith('user-1', 4);
  });
});
