import { BadRequestException, Injectable } from '@nestjs/common';
import { isSalutation } from '../communications/salutation';
import {
  BILL_MESSAGE_VARIABLES,
  findUnknownVariables,
} from '../communications/template-variables';
import { PrismaService } from '../prisma/prisma.service';
import { IRREGULAR_PRESETS } from './dto/whatsapp-profile.dto';
import type { UpdateWhatsappAutomationProfileDto } from './dto/whatsapp-profile.dto';

const COUNTRY_CODE_RE = /^\d{1,4}$/;

/** Code defaults when the gym never saved a profile row: reads answer
 * these without writing anything, so deploying this never changes what
 * any existing gym sends. */
export const WHATSAPP_PROFILE_DEFAULTS = {
  salutation: 'Hello',
  autoResend: true,
  maxResendAttempts: 8,
  defaultCountryCode: '91',
  customBillMessage: null as string | null,
  irregularThresholdDays: 7,
  irregularCustomDays: null as number | null,
  timezone: 'Asia/Kolkata',
} as const;

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class WhatsappProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /** This gym's preferences merged over the defaults. No row means
   * defaults -- reads never create one. */
  async get(organizationId: string) {
    const row = await this.prisma.whatsappAutomationProfile.findUnique({
      where: { organizationId },
    });
    return {
      organizationId,
      salutation: row?.salutation ?? WHATSAPP_PROFILE_DEFAULTS.salutation,
      autoResend: row?.autoResend ?? WHATSAPP_PROFILE_DEFAULTS.autoResend,
      maxResendAttempts:
        row?.maxResendAttempts ?? WHATSAPP_PROFILE_DEFAULTS.maxResendAttempts,
      defaultCountryCode:
        row?.defaultCountryCode ?? WHATSAPP_PROFILE_DEFAULTS.defaultCountryCode,
      customBillMessage:
        row?.customBillMessage ?? WHATSAPP_PROFILE_DEFAULTS.customBillMessage,
      irregularThresholdDays:
        row?.irregularThresholdDays ??
        WHATSAPP_PROFILE_DEFAULTS.irregularThresholdDays,
      irregularCustomDays:
        row?.irregularCustomDays ??
        WHATSAPP_PROFILE_DEFAULTS.irregularCustomDays,
      timezone: row?.timezone ?? WHATSAPP_PROFILE_DEFAULTS.timezone,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** Partial update: only the fields present in the DTO are written, so
   * saving one preference can never wipe the others. */
  async update(
    organizationId: string,
    dto: UpdateWhatsappAutomationProfileDto,
  ) {
    this.validate(dto);
    const data: {
      salutation?: string;
      autoResend?: boolean;
      maxResendAttempts?: number;
      defaultCountryCode?: string;
      customBillMessage?: string | null;
      irregularThresholdDays?: number;
      irregularCustomDays?: number | null;
      timezone?: string;
    } = {};
    if (dto.salutation !== undefined) data.salutation = dto.salutation;
    if (dto.autoResend !== undefined) data.autoResend = dto.autoResend;
    if (dto.maxResendAttempts !== undefined)
      data.maxResendAttempts = dto.maxResendAttempts;
    if (dto.defaultCountryCode !== undefined)
      data.defaultCountryCode = dto.defaultCountryCode;
    if (dto.customBillMessage !== undefined)
      data.customBillMessage = dto.customBillMessage;
    if (dto.irregularThresholdDays !== undefined)
      data.irregularThresholdDays = dto.irregularThresholdDays;
    if (dto.irregularCustomDays !== undefined)
      data.irregularCustomDays = dto.irregularCustomDays;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (Object.keys(data).length === 0) return this.get(organizationId);
    await this.prisma.whatsappAutomationProfile.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
    return this.get(organizationId);
  }

  /** Effective inactivity threshold in days: an explicit custom value
   * wins over the preset. */
  async irregularThreshold(organizationId: string): Promise<number> {
    const profile = await this.get(organizationId);
    return profile.irregularCustomDays ?? profile.irregularThresholdDays;
  }

  /** Service-level checks so direct callers get the same rejects as the
   * DTO-validated HTTP route. */
  private validate(dto: UpdateWhatsappAutomationProfileDto): void {
    if (dto.salutation !== undefined && !isSalutation(dto.salutation)) {
      throw new BadRequestException(
        'salutation must be one of: Dear, Hello, Respected, Hi, Hey, Greetings',
      );
    }
    if (
      dto.maxResendAttempts !== undefined &&
      (!Number.isInteger(dto.maxResendAttempts) ||
        dto.maxResendAttempts < 1 ||
        dto.maxResendAttempts > 8)
    ) {
      throw new BadRequestException(
        'maxResendAttempts must be an integer 1..8',
      );
    }
    if (
      dto.defaultCountryCode !== undefined &&
      !COUNTRY_CODE_RE.test(dto.defaultCountryCode)
    ) {
      throw new BadRequestException(
        'defaultCountryCode must be 1-4 digits, e.g. 91',
      );
    }
    if (dto.customBillMessage !== undefined && dto.customBillMessage !== null) {
      if (dto.customBillMessage.length > 1000) {
        throw new BadRequestException(
          'customBillMessage must be at most 1000 characters',
        );
      }
      const unknown = findUnknownVariables(
        dto.customBillMessage,
        BILL_MESSAGE_VARIABLES,
      );
      if (unknown.length > 0) {
        throw new BadRequestException(
          `customBillMessage uses unknown variables: ${unknown.join(', ')}`,
        );
      }
    }
    if (
      dto.irregularThresholdDays !== undefined &&
      !(IRREGULAR_PRESETS as readonly number[]).includes(
        dto.irregularThresholdDays,
      )
    ) {
      throw new BadRequestException(
        'irregularThresholdDays must be one of 3, 7, 15, 30',
      );
    }
    if (
      dto.irregularCustomDays !== undefined &&
      dto.irregularCustomDays !== null &&
      (!Number.isInteger(dto.irregularCustomDays) ||
        dto.irregularCustomDays < 1 ||
        dto.irregularCustomDays > 90)
    ) {
      throw new BadRequestException(
        'irregularCustomDays must be an integer 1..90',
      );
    }
    if (dto.timezone !== undefined && !isValidTimezone(dto.timezone)) {
      throw new BadRequestException('timezone must be a valid IANA name');
    }
  }
}
