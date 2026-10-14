import { MembershipExpiryOnDayScanner } from './membership-expiry-on-day.scanner';

const org = { timezone: 'Asia/Kolkata' };
const NOW = new Date('2026-10-12T09:00:00.000Z');
const TODAY = new Date('2026-10-12T18:00:00.000Z');

function harness(memberships: unknown[], sendWindowOpen = true) {
  const messenger = {
    sendWindowOpen: jest.fn(async () => sendWindowOpen),
    deliver: jest.fn(async () => ({ outcome: 'SENT', channel: 'WHATSAPP' })),
  };
  const communications = {
    sendMembershipRenewalReminder: jest.fn(async () => ({ status: 'SENT' })),
  };
  const prisma = {
    membership: { findMany: jest.fn(async () => memberships) },
  };
  const scanner = new MembershipExpiryOnDayScanner(
    prisma as never,
    communications as never,
    messenger as never,
  );
  return { scanner, messenger, communications };
}

const endingToday = (id: string, later: string | null = null) => ({
  id,
  organizationId: 'org_1',
  endDate: TODAY,
  member: {
    id: `m-${id}`,
    email: 'a@x.com',
    phone: '919876543210',
    firstName: 'Asha',
    memberships: later ? [{ id: 'mem2', endDate: new Date(later) }] : [],
  },
  membershipPlan: { name: 'Monthly' },
  organization: org,
});

describe('MembershipExpiryOnDayScanner', () => {
  it('sends on the day the membership ends, under its own key', async () => {
    const { scanner, messenger } = harness([endingToday('mem1')]);

    expect(await scanner.scan(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(messenger.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'MEMBERSHIP_EXPIRY_ON_DAY',
        subjectId: 'mem1',
        whatsapp: expect.objectContaining({
          templateKey: 'renewal.t0',
          stage: 't0',
        }),
      }),
    );
  });

  it('skips a member who already holds a later membership', async () => {
    const { scanner, messenger } = harness([
      endingToday('mem1', '2026-11-12T00:00:00Z'),
    ]);
    expect(await scanner.scan(NOW)).toEqual({ checked: 0, sent: 0 });
    expect(messenger.deliver).not.toHaveBeenCalled();
  });

  it('sends nothing when the switch is off', async () => {
    const { scanner, messenger } = harness([endingToday('mem1')], false);
    expect(await scanner.scan(NOW)).toEqual({ checked: 0, sent: 0 });
    expect(messenger.deliver).not.toHaveBeenCalled();
  });
});
