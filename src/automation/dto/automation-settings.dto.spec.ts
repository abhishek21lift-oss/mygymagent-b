import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateAutomationSettingDto } from './automation-settings.dto';

async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(UpdateAutomationSettingDto, body);
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('UpdateAutomationSettingDto', () => {
  it('accepts an empty patch and explicit nulls', async () => {
    await expect(errorsFor({})).resolves.toEqual([]);
    await expect(
      errorsFor({
        enabled: true,
        channelOverride: null,
        cooldownDays: null,
        quietHoursStart: null,
        quietHoursEnd: null,
      }),
    ).resolves.toEqual([]);
  });

  it('rejects bad quiet-hours values, bad channels and out-of-range cooldowns', async () => {
    await expect(
      errorsFor({ quietHoursStart: '25:00', quietHoursEnd: '06:00' }),
    ).resolves.not.toEqual([]);
    await expect(
      errorsFor({ quietHoursStart: '9pm', quietHoursEnd: '06:00' }),
    ).resolves.not.toEqual([]);
    await expect(errorsFor({ channelOverride: 'SMS' })).resolves.not.toEqual(
      [],
    );
    await expect(errorsFor({ cooldownDays: -1 })).resolves.not.toEqual([]);
    await expect(errorsFor({ cooldownDays: 366 })).resolves.not.toEqual([]);
    await expect(errorsFor({ cooldownDays: 1.5 })).resolves.not.toEqual([]);
    await expect(errorsFor({ enabled: 'yes' })).resolves.not.toEqual([]);
  });

  it('accepts a full valid patch', async () => {
    await expect(
      errorsFor({
        enabled: false,
        channelOverride: 'WHATSAPP',
        cooldownDays: 30,
        quietHoursStart: '22:00',
        quietHoursEnd: '06:00',
      }),
    ).resolves.toEqual([]);
  });
});
