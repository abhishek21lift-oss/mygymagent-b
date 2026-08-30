import { DataRetentionScanner } from './data-retention.scanner';
import { PrismaService } from '../../prisma/prisma.service';

describe('DataRetentionScanner', () => {
  let scanner: DataRetentionScanner;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = {
      auditLog: {
        deleteMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
      refreshToken: {
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      passwordResetToken: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      userPermissionOverride: {
        deleteMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
      emailVerificationToken: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;

    scanner = new DataRetentionScanner(prisma);
  });

  it('should be defined', () => {
    expect(scanner).toBeDefined();
  });

  it('should run data retention scan successfully', async () => {
    await scanner.scan();

    // Verify all deleteMany methods were called
    expect(prisma.auditLog.deleteMany).toHaveBeenCalled();
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalled();
    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalled();
    expect(prisma.userPermissionOverride.deleteMany).toHaveBeenCalled();
    expect(prisma.emailVerificationToken.deleteMany).toHaveBeenCalled();

    // Verify logger was called
    // Note: In a real test, we would spy on the logger, but for simplicity
    // we're just verifying the scanner executes without throwing
  });
});
