import { BirthdayScanner } from './birthday.scanner';

/** 04:00 on 12 Oct 2026 in Kolkata (UTC+5:30) -- the hour the
 * BIRTHDAY_WISH default runs in. */
const TODAY_4AM_KOLKATA = new Date('2026-10-11T22:30:00.000Z');
/** A stored date of birth that is 12 October in Kolkata. */
const DOB_12_OCT = new Date('1990-10-12T00:00:00.000Z');

function harness(members: unknown[]) {
  const messenger = {
    sendWindowOpen: jest.fn(async () => true),
    automationEnabled: jest.fn(async () => true),
    deliver: jest.fn(async () => ({ outcome: 'SENT', channel: 'WHATSAPP' })),
  };
  const profiles = {
    get: jest.fn(async () => ({ timezone: 'Asia/Kolkata' })),
    irregularThreshold: jest.fn(async () => 7),
  };
  const prisma = {
    member: { findMany: jest.fn(async () => members) },
  };
  const scanner = new BirthdayScanner(
    prisma as never,
    messenger as never,
    profiles as never,
  );
  return { scanner, messenger, profiles, prisma };
}

const org1 = { name: 'Test Gym', timezone: 'Asia/Kolkata' };

describe('BirthdayScanner', () => {
  it('sends to a member whose birthday is today in the gym timezone', async () => {
    const { scanner, messenger } = harness([
      {
        id: 'm1',
        organizationId: 'org_1',
        firstName: 'Asha',
        phone: '919876543210',
        dateOfBirth: DOB_12_OCT,
        organization: org1,
      },
    ]);

    const result = await scanner.scan(TODAY_4AM_KOLKATA);

    expect(result).toEqual({ checked: 1, sent: 1 });
    expect(messenger.deliver).toHaveBeenCalledTimes(1);
    expect(messenger.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'BIRTHDAY_WISH',
        subjectId: expect.stringMatching(/^m1:\d{4}$/),
        whatsapp: expect.objectContaining({
          templateKey: 'birthday',
          variables: { '1': 'Asha', '2': 'Test Gym' },
        }),
      }),
    );
  });

  it('skips members whose birthday is not today', async () => {
    const { scanner, messenger } = harness([
      {
        id: 'm1',
        organizationId: 'org_1',
        firstName: 'Asha',
        phone: '919876543210',
        dateOfBirth: new Date('1990-10-13T00:00:00Z'),
        organization: org1,
      },
    ]);
    expect(await scanner.scan(TODAY_4AM_KOLKATA)).toEqual({
      checked: 0,
      sent: 0,
    });
    expect(messenger.deliver).not.toHaveBeenCalled();
  });

  it('sends nothing when the switch is off', async () => {
    const { scanner, messenger } = harness([
      {
        id: 'm1',
        organizationId: 'org_1',
        firstName: 'Asha',
        phone: '919876543210',
        dateOfBirth: DOB_12_OCT,
        organization: org1,
      },
    ]);
    messenger.sendWindowOpen.mockResolvedValue(false);

    expect(await scanner.scan(TODAY_4AM_KOLKATA)).toEqual({
      checked: 0,
      sent: 0,
    });
    expect(messenger.deliver).not.toHaveBeenCalled();
  });

  it('uses the gym-local day, not the UTC day', async () => {
    // 22:30 UTC on 11 Oct is already 04:00 on 12 Oct in Kolkata.
    const { scanner } = harness([
      {
        id: 'm1',
        organizationId: 'org_1',
        firstName: 'Asha',
        phone: '919876543210',
        dateOfBirth: DOB_12_OCT,
        organization: org1,
      },
    ]);
    expect(await scanner.scan(new Date('2026-10-11T22:30:00Z'))).toEqual({
      checked: 1,
      sent: 1,
    });
  });
});
