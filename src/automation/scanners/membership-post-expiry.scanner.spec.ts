import { MembershipPostExpiryScanner } from './membership-post-expiry.scanner';

const org = { timezone: 'Asia/Kolkata' };
const NOW = new Date('2026-10-12T09:00:00.000Z');

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
  const scanner = new MembershipPostExpiryScanner(
    prisma as never,
    communications as never,
    messenger as never,
  );
  return { scanner, messenger };
}

const lapsed = (id: string, endDate: string) => ({
  id,
  organizationId: 'org_1',
  endDate: new Date(endDate),
  member: {
    id: `m-${id}`,
    email: 'a@x.com',
    phone: '919876543210',
    firstName: 'Asha',
    memberships: [],
  },
  membershipPlan: { name: 'Monthly' },
  organization: org,
});

describe('MembershipPostExpiryScanner', () => {
  it('nudges a membership that lapsed recently under its own key', async () => {
    const { scanner, messenger } = harness([
      lapsed('mem1', '2026-10-09T00:00:00Z'),
    ]);

    expect(await scanner.scan(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(messenger.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'MEMBERSHIP_POST_EXPIRY',
        subjectId: 'mem1:post',
        whatsapp: expect.objectContaining({
          templateKey: 'post_expiry.nudge',
        }),
      }),
    );
  });

  it('skips a member who already renewed', async () => {
    const { scanner, messenger } = harness([
      {
        ...lapsed('mem1', '2026-10-09T00:00:00Z'),
        member: {
          id: 'm-mem1',
          email: 'a@x.com',
          phone: '919876543210',
          firstName: 'Asha',
          memberships: [
            { id: 'mem2', endDate: new Date('2026-12-01T00:00:00Z') },
          ],
        },
      },
    ]);
    expect(await scanner.scan(NOW)).toEqual({ checked: 0, sent: 0 });
    expect(messenger.deliver).not.toHaveBeenCalled();
  });

  it('sends nothing when the switch is off', async () => {
    const { scanner, messenger } = harness(
      [lapsed('mem1', '2026-10-09T00:00:00Z')],
      false,
    );
    expect(await scanner.scan(NOW)).toEqual({ checked: 0, sent: 0 });
    expect(messenger.deliver).not.toHaveBeenCalled();
  });
});
