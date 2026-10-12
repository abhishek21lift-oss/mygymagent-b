import { BadRequestException } from '@nestjs/common';
import { WhatsappProfileService } from './whatsapp-profile.service';

function service(row: Record<string, unknown> | null = null) {
  const stored = new Map<string, Record<string, unknown>>();
  if (row) stored.set('org_1', row);
  const prisma = {
    whatsappAutomationProfile: {
      findUnique: jest.fn(
        async ({ where: { organizationId } }) =>
          stored.get(organizationId) ?? null,
      ),
      upsert: jest.fn(
        async ({
          where: { organizationId },
          create,
          update,
        }: {
          where: { organizationId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const next = stored.get(organizationId)
            ? { ...stored.get(organizationId), ...update }
            : { ...create };
          stored.set(organizationId, next);
          return next;
        },
      ),
    },
  };
  return { svc: new WhatsappProfileService(prisma as never), prisma, stored };
}

describe('WhatsappProfileService.get', () => {
  it('answers defaults without writing a row', async () => {
    const { svc, prisma } = service();
    const profile = await svc.get('org_1');
    expect(profile).toMatchObject({
      salutation: 'Hello',
      autoResend: true,
      maxResendAttempts: 8,
      defaultCountryCode: '91',
      customBillMessage: null,
      irregularThresholdDays: 7,
      timezone: 'Asia/Kolkata',
    });
    // A read must never create a preferences row for a gym.
    expect(prisma.whatsappAutomationProfile.upsert).not.toHaveBeenCalled();
  });
});

describe('WhatsappProfileService.update', () => {
  it('saves one preference without touching the others', async () => {
    const { svc } = service({ organizationId: 'org_1', salutation: 'Dear' });

    const updated = await svc.update('org_1', { autoResend: false });
    expect(updated).toMatchObject({
      salutation: 'Dear',
      autoResend: false,
      maxResendAttempts: 8,
    });
  });

  it('persists the salutation, resend policy and bill message', async () => {
    const { svc } = service();
    await svc.update('org_1', {
      salutation: 'Respected',
      autoResend: false,
      maxResendAttempts: 3,
      customBillMessage: '{{salutation}} {{firstName}}, due {{amount}}',
    });
    const profile = await svc.get('org_1');
    expect(profile).toMatchObject({
      salutation: 'Respected',
      autoResend: false,
      maxResendAttempts: 3,
      customBillMessage: '{{salutation}} {{firstName}}, due {{amount}}',
    });
  });

  it('rejects unknown salutations, codes, retry bounds and variables', async () => {
    const { svc } = service();
    await expect(
      svc.update('org_1', { salutation: 'Yo' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.update('org_1', { maxResendAttempts: 9 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.update('org_1', { defaultCountryCode: 'XYZ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.update('org_1', {
        customBillMessage: 'Hi {{nickname}}, {{amount}}',
      }),
    ).rejects.toThrow(/unknown variables/i);
  });

  it('rejects timezones that are not IANA names', async () => {
    const { svc } = service();
    await expect(
      svc.update('org_1', { timezone: 'Mars/Olympus' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.update('org_1', { timezone: 'Europe/Berlin' }),
    ).resolves.toMatchObject({ timezone: 'Europe/Berlin' });
  });

  it('accepts preset thresholds and a bounded custom period', async () => {
    const { svc } = service();
    await svc.update('org_1', { irregularThresholdDays: 30 });
    expect((await svc.get('org_1')).irregularThresholdDays).toBe(30);
    await svc.update('org_1', { irregularCustomDays: 45 });
    expect(await svc.irregularThreshold('org_1')).toBe(45);
    await expect(
      svc.update('org_1', { irregularThresholdDays: 45 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.update('org_1', { irregularCustomDays: 120 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
