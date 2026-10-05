import 'reflect-metadata';
import { MembershipLifecycleService } from './membership-lifecycle.service';

const DAY = 24 * 60 * 60 * 1000;

function membership(
  id: string,
  memberId: string,
  endDate: Date,
  status: 'ACTIVE' | 'EXPIRED',
  price = '5000.00',
) {
  return {
    id,
    memberId,
    endDate,
    status,
    price: { toString: () => price },
    currency: 'INR',
    membershipPlan: { name: 'Monthly' },
    member: { id: memberId, firstName: 'A', lastName: 'B' },
  };
}

describe('MembershipLifecycleService.getRenewalPipeline', () => {
  it('splits upcoming, overdue (no successor) and high-value', async () => {
    const now = new Date();
    const in5 = new Date(now.getTime() + 5 * DAY);
    const in20 = new Date(now.getTime() + 20 * DAY);
    const expired10 = new Date(now.getTime() - 10 * DAY);
    const prisma = {
      membership: {
        findMany: jest
          .fn()
          // upcoming ACTIVE
          .mockResolvedValueOnce([
            membership('up-cheap', 'm1', in20, 'ACTIVE', '2000.00'),
            membership('up-rich', 'm2', in5, 'ACTIVE', '20000.00'),
          ])
          // recently expired
          .mockResolvedValueOnce([
            membership('lost', 'm3', expired10, 'EXPIRED', '8000.00'),
            membership('renewed', 'm4', expired10, 'EXPIRED', '9000.00'),
          ])
          // active member ids (m4 already renewed)
          .mockResolvedValueOnce([{ memberId: 'm4' }]),
      },
    };
    const service = new MembershipLifecycleService(prisma as never);
    const pipeline = await service.getRenewalPipeline('org-1', null);
    expect(pipeline.upcoming.map((m) => m.membershipId)).toEqual([
      'up-rich',
      'up-cheap',
    ]);
    expect(pipeline.upcoming[0].daysUntilExpiry).toBe(5);
    // m3 never renewed -> overdue; m4 holds an ACTIVE term -> not overdue.
    expect(pipeline.overdue.map((m) => m.membershipId)).toEqual(['lost']);
    expect(pipeline.highValue.map((m) => m.membershipId)).toEqual([
      'up-rich',
      'up-cheap',
    ]);
    expect(pipeline.counts).toEqual({ upcoming: 2, overdue: 1 });
  });
});
