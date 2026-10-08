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
      webhookDelivery: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
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
    expect(prisma.emailVerificationToken.deleteMany).toHaveBeenCalled();
  });

  it('never deletes permission overrides, however old', async () => {
    await scanner.scan();

    // This used to assert the opposite. An override is live access
    // control with no expiry -- a year-old DENY still denies -- so
    // deleting it by age hands back access an administrator removed.
    expect(prisma.userPermissionOverride.deleteMany).not.toHaveBeenCalled();
  });
});
