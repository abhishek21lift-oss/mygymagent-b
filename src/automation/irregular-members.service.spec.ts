import { BadRequestException } from '@nestjs/common';
import { IrregularMembersService } from './irregular-members.service';

const NOW = new Date('2026-10-12T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

function member(
  id: string,
  daysSinceLastVisit: number | null,
  membership: { status: string; endDate: Date } | null = null,
  organizationId = 'org_1',
) {
  return {
    id,
    organizationId,
    firstName: 'Asha',
    lastName: 'Rao',
    phone: '919876543210',
    email: 'a@x.com',
    joinedAt: daysAgo(200),
    attendances:
      daysSinceLastVisit === null
        ? []
        : [{ checkInAt: daysAgo(daysSinceLastVisit) }],
    memberships: membership ? [membership] : [],
  };
}

function service(rows: unknown[], threshold = 7) {
  const prisma = {
    member: { findMany: jest.fn(async () => rows) },
  };
  const profiles = { irregularThreshold: jest.fn(async () => threshold) };
  return new IrregularMembersService(prisma as never, profiles as never);
}

describe('IrregularMembersService.list', () => {
  it('lists only members past the range, longest absence first', async () => {
    const svc = service([member('m1', 3), member('m2', 20), member('m3', 10)]);

    const report = await svc.list('org_1', 7, NOW);

    expect(report.thresholdDays).toBe(7);
    expect(report.members.map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(report.members[0].daysInactive).toBe(20);
  });

  it('falls back to the gym-saved threshold when no range is given', async () => {
    const svc = service([member('m1', 10)], 15);
    const report = await svc.list('org_1', undefined, NOW);
    expect(report.thresholdDays).toBe(15);
    expect(report.members).toEqual([]);
  });

  it('uses joinedAt for a member who has never checked in', async () => {
    const svc = service([member('m1', null)]);
    const report = await svc.list('org_1', 7, NOW);
    // joined 200 days ago, never visited.
    expect(report.members[0].daysInactive).toBe(200);
    expect(report.members[0].lastCheckInAt).toBeNull();
  });

  it('reports subscription Active / Inactive / None from the newest membership', async () => {
    const svc = service([
      member('active', 10, {
        status: 'ACTIVE',
        endDate: daysAgo(-5),
      }),
      member('expired', 10, {
        status: 'ACTIVE',
        endDate: daysAgo(5),
      }),
      member('lapsed', 10, {
        status: 'EXPIRED',
        endDate: daysAgo(5),
      }),
      member('none', 10, null),
    ]);

    const report = await svc.list('org_1', 7, NOW);
    const byId = new Map(report.members.map((m) => [m.id, m]));

    expect(byId.get('active')!.subscriptionStatus).toBe('ACTIVE');
    expect(byId.get('expired')!.subscriptionStatus).toBe('INACTIVE');
    expect(byId.get('lapsed')!.subscriptionStatus).toBe('INACTIVE');
    expect(byId.get('none')!.subscriptionStatus).toBe('NONE');
  });

  it('is a behavioural list: a member marked INACTIVE who visits daily is not irregular', async () => {
    const svc = service([{ ...member('m1', 0), status: 'INACTIVE' }]);
    expect((await svc.list('org_1', 7, NOW)).members).toEqual([]);
  });

  it('scopes every query to the caller organization', async () => {
    const prisma = { member: { findMany: jest.fn(async () => []) } };
    const svc = new IrregularMembersService(
      prisma as never,
      { irregularThreshold: jest.fn(async () => 7) } as never,
    );

    await svc.list('org_caller', 7, NOW);

    // Org B's rows can never appear: the query carries the caller's id.
    expect(prisma.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org_caller' }),
      }),
    );
  });

  it('never writes or sends while listing', async () => {
    const rows = [member('m1', 30)];
    const prisma = {
      member: { findMany: jest.fn(async () => rows) },
      // Any send path would have to go through one of these.
      automationRun: { create: jest.fn() },
      messageLog: { create: jest.fn() },
    };
    const svc = new IrregularMembersService(
      prisma as never,
      { irregularThreshold: jest.fn(async () => 7) } as never,
    );

    await svc.list('org_1', 7, NOW);

    expect(prisma.automationRun.create).not.toHaveBeenCalled();
    expect(prisma.messageLog.create).not.toHaveBeenCalled();
  });

  it('rejects a range outside 1..90 days', async () => {
    const svc = service([]);
    await expect(svc.list('org_1', 0, NOW)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.list('org_1', 'abc', NOW)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.list('org_1', 91, NOW)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.list('org_1', '30', NOW)).resolves.toMatchObject({
      thresholdDays: 30,
    });
  });
});
