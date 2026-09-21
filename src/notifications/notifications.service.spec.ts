import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  it('fans out only to active users who have not disabled the category in-app', async () => {
    const prisma = {
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'user-1' },
            { id: 'user-2' },
            { id: 'user-3' },
          ]),
      },
      notificationPreference: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ userId: 'user-2', inApp: false }]),
      },
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    const service = new NotificationsService(prisma as never);

    await expect(
      service.notifyOrganization('org-1', {
        type: 'PAYMENT_RECORDED',
        title: 'Payment recorded',
        body: 'A payment was recorded.',
        metadata: { paymentId: 'payment-1' },
      }),
    ).resolves.toEqual({ created: 2 });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        deletedAt: null,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    expect(prisma.notificationPreference.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        userId: { in: ['user-1', 'user-2', 'user-3'] },
        category: 'PAYMENT_RECORDED',
      },
      select: { userId: true, inApp: true },
    });
    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        {
          organizationId: 'org-1',
          userId: 'user-1',
          type: 'PAYMENT_RECORDED',
          title: 'Payment recorded',
          body: 'A payment was recorded.',
          actionUrl: undefined,
          metadata: { paymentId: 'payment-1' },
        },
        {
          organizationId: 'org-1',
          userId: 'user-3',
          type: 'PAYMENT_RECORDED',
          title: 'Payment recorded',
          body: 'A payment was recorded.',
          actionUrl: undefined,
          metadata: { paymentId: 'payment-1' },
        },
      ],
    });
  });

  it('does not write notifications when the organization has no active users', async () => {
    const prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      notificationPreference: { findMany: jest.fn() },
      notification: { createMany: jest.fn() },
    };

    const service = new NotificationsService(prisma as never);

    await expect(
      service.notifyOrganization('org-1', {
        type: 'LEAD_CREATED',
        title: 'New lead',
        body: 'A new lead was created.',
      }),
    ).resolves.toEqual({ created: 0 });

    expect(prisma.notificationPreference.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});
