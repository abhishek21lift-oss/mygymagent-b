import { MemberInactiveScanner } from './member-inactive.scanner';

const NOW = new Date('2026-10-12T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const org = { name: 'Test Gym', timezone: 'Asia/Kolkata' };

function harness(
  members: unknown[],
  thresholdDays: number,
  sendWindowOpen = true,
) {
  const messenger = {
    sendWindowOpen: jest.fn(async () => sendWindowOpen),
    deliver: jest.fn(
      async (_message: { whatsapp?: { templateKey: string } }) => ({
        outcome: 'SENT',
        channel: 'WHATSAPP',
      }),
    ),
  };
  const communications = {
    sendInactiveMemberRecovery: jest.fn(async () => ({ status: 'SENT' })),
  };
  const profiles = { irregularThreshold: jest.fn(async () => thresholdDays) };
  const prisma = {
    member: { findMany: jest.fn(async () => members) },
    automationRun: { findFirst: jest.fn(async () => null) },
  };
  const scanner = new MemberInactiveScanner(
    prisma as never,
    communications as never,
    messenger as never,
    profiles as never,
  );
  return { scanner, messenger, communications };
}

/** A member whose last check-in was `daysAgo` days before NOW. */
function member(
  id: string,
  daysAgo: number,
  opts: { phone?: boolean; consent?: boolean } = {},
) {
  const withPhone = opts.phone !== false;
  return {
    id,
    organizationId: 'org_1',
    email: `${id}@x.com`,
    phone: withPhone ? '919876543210' : null,
    firstName: 'Asha',
    joinedAt: new Date(NOW.getTime() - 200 * DAY),
    attendances: [{ checkInAt: new Date(NOW.getTime() - daysAgo * DAY) }],
    consents: [{ granted: opts.consent ?? false }],
    organization: org,
  };
}

describe('MemberInactiveScanner', () => {
  it('uses the gym-configured threshold instead of the hardcoded 30', async () => {
    // 10 days absent: past a 7-day threshold, inside the old 30-day one.
    const { scanner, messenger } = harness([member('m1', 10)], 7);

    expect(await scanner.scan(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(messenger.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'MEMBER_INACTIVE_RECOVERY',
        subjectId: 'm1',
      }),
    );
  });

  it('leaves a member inside the threshold alone', async () => {
    const { scanner, messenger } = harness([member('m1', 2)], 7);
    expect(await scanner.scan(NOW)).toEqual({ checked: 0, sent: 0 });
    expect(messenger.deliver).not.toHaveBeenCalled();
  });

  it('measures attendance inactivity, not Member.status', async () => {
    // Member.status stays ACTIVE (staff classification); this member is
    // behaviourally irregular and has been told nothing this absence.
    const { scanner } = harness([member('m1', 9)], 7);
    expect(await scanner.scan(NOW)).toEqual({ checked: 1, sent: 1 });
  });

  it('sends WhatsApp only to members who gave marketing consent', async () => {
    const { scanner, messenger } = harness(
      [
        member('m1', 10, { consent: true }),
        member('m2', 10, { consent: false }),
      ],
      7,
    );

    await scanner.scan(NOW);

    const calls = messenger.deliver.mock.calls.map((c) => c[0]);
    expect(calls[0].whatsapp).toBeDefined();
    expect(calls[0].whatsapp!.templateKey).toBe('inactive.winback');
    // No consent: email only, no WhatsApp attempt.
    expect(calls[1].whatsapp).toBeUndefined();
    expect(calls[1]).toHaveProperty('email');
  });
});
