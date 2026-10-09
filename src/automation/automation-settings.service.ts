import { BadRequestException, Injectable } from '@nestjs/common';
import type { AutomationKey } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CHANNEL_OVERRIDES,
  type UpdateAutomationSettingDto,
} from './dto/automation-settings.dto';

/**
 * Every automation key the Control Center can switch. The eight live
 * scanner keys plus the two the upcoming schedules need: BIRTHDAY_WISH
 * (birthdays via Member.dateOfBirth) and MEMBERSHIP_POST_EXPIRY
 * (follow-ups after endDate -- renewal stages t7/t3/t0 under
 * MEMBERSHIP_RENEWAL_REMINDER only cover the window before it).
 */
export const AUTOMATION_SETTING_KEYS: AutomationKey[] = [
  'PAYMENT_OVERDUE_REMINDER',
  'MEMBERSHIP_RENEWAL_REMINDER',
  'INVOICE_DUE_REMINDER',
  'PT_EXPIRY_REMINDER',
  'MEMBER_INACTIVE_RECOVERY',
  'LEAD_FIRST_TOUCH',
  'LEAD_FOLLOWUP_REMINDER',
  'LOW_STOCK_ALERT',
  'BIRTHDAY_WISH',
  'MEMBERSHIP_POST_EXPIRY',
];

const QUIET_HOURS_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

@Injectable()
export class AutomationSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** All keys merged with this gym's rows. No row means the code default:
   * enabled, AUTO channel, the scanner's own cooldown. */
  async list(organizationId: string) {
    const rows = await this.prisma.automationSetting.findMany({
      where: { organizationId },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return AUTOMATION_SETTING_KEYS.map((key) => {
      const row = byKey.get(key);
      return {
        key,
        enabled: row?.enabled ?? true,
        channelOverride: row?.channelOverride ?? null,
        cooldownDays: row?.cooldownDays ?? null,
        quietHoursStart: row?.quietHoursStart ?? null,
        quietHoursEnd: row?.quietHoursEnd ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async update(
    organizationId: string,
    keyRaw: string,
    dto: UpdateAutomationSettingDto,
    _actorUserId?: string,
  ) {
    const key = parseKey(keyRaw);
    const existing = await this.prisma.automationSetting.findUnique({
      where: { organizationId_key: { organizationId, key } },
    });
    validateUpdate(dto, existing);
    const data: {
      enabled?: boolean;
      channelOverride?: string | null;
      cooldownDays?: number | null;
      quietHoursStart?: string | null;
      quietHoursEnd?: string | null;
    } = {};
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.channelOverride !== undefined)
      data.channelOverride = dto.channelOverride;
    if (dto.cooldownDays !== undefined) data.cooldownDays = dto.cooldownDays;
    if (dto.quietHoursStart !== undefined)
      data.quietHoursStart = dto.quietHoursStart;
    if (dto.quietHoursEnd !== undefined) data.quietHoursEnd = dto.quietHoursEnd;
    // A body with no fields changes nothing -- answer the current state
    // without writing a row for it.
    if (Object.keys(data).length === 0) {
      return (
        existing ?? {
          key,
          organizationId,
          enabled: true,
          channelOverride: null,
          cooldownDays: null,
          quietHoursStart: null,
          quietHoursEnd: null,
        }
      );
    }
    return this.prisma.automationSetting.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, ...data },
      update: data,
    });
  }
}

function parseKey(keyRaw: string): AutomationKey {
  const key = (keyRaw ?? '').toUpperCase() as AutomationKey;
  if (!AUTOMATION_SETTING_KEYS.includes(key)) {
    throw new BadRequestException(`Unknown automation key: ${keyRaw}`);
  }
  return key;
}

/** Service-level check so direct callers get the same rejects as the
 * DTO-validated HTTP route. */
function validateUpdate(
  dto: UpdateAutomationSettingDto,
  existing: {
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
  } | null,
): void {
  if (
    dto.channelOverride !== undefined &&
    dto.channelOverride !== null &&
    !(CHANNEL_OVERRIDES as readonly string[]).includes(dto.channelOverride)
  ) {
    throw new BadRequestException(
      'channelOverride must be AUTO, WHATSAPP or EMAIL',
    );
  }
  if (
    dto.cooldownDays !== undefined &&
    dto.cooldownDays !== null &&
    (!Number.isInteger(dto.cooldownDays) ||
      dto.cooldownDays < 0 ||
      dto.cooldownDays > 365)
  ) {
    throw new BadRequestException('cooldownDays must be an integer 0..365');
  }
  const start =
    dto.quietHoursStart !== undefined
      ? dto.quietHoursStart
      : (existing?.quietHoursStart ?? null);
  const end =
    dto.quietHoursEnd !== undefined
      ? dto.quietHoursEnd
      : (existing?.quietHoursEnd ?? null);
  for (const [label, value] of [
    ['quietHoursStart', start],
    ['quietHoursEnd', end],
  ] as const) {
    if (value !== null && !QUIET_HOURS_RE.test(value)) {
      throw new BadRequestException(`${label} must be HH:mm (24h)`);
    }
  }
  // Half a window silences nothing and resumes nothing: both or neither.
  if ((start === null) !== (end === null)) {
    throw new BadRequestException(
      'quietHoursStart and quietHoursEnd must be set together',
    );
  }
}
