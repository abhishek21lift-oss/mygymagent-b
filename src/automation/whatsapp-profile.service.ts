import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  BILL_VARIABLES,
  findUnknownBillVariables,
  type UpdateWhatsappProfileDto,
} from './dto/whatsapp-profile.dto';

export const DEFAULT_SALUTATION = 'Hello';
const DEFAULT_MAX_RESEND_ATTEMPTS = 3;
const DEFAULT_COUNTRY_CODE = '91';
const DEFAULT_IRREGULAR_THRESHOLD_DAYS = 14;

/**
 * Per-gym WhatsApp delivery preferences behind GET/PATCH
 * /automation/whatsapp-profile (Important settings + Customer salutation
 * cards). Reads answer merged defaults without creating a row, so an
 * unconfigured gym sees a working form, never a 404. Every read and
 * write is scoped by organizationId: one gym's profile never touches
 * another's.
 */
@Injectable()
export class WhatsappProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async get(organizationId: string) {
    const [row, organization] = await Promise.all([
      this.prisma.whatsappProfile.findUnique({ where: { organizationId } }),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { timezone: true },
      }),
    ]);
    return {
      organizationId,
      salutation: row?.salutation ?? DEFAULT_SALUTATION,
      autoResend: row?.autoResend ?? false,
      maxResendAttempts: row?.maxResendAttempts ?? DEFAULT_MAX_RESEND_ATTEMPTS,
      defaultCountryCode: row?.defaultCountryCode ?? DEFAULT_COUNTRY_CODE,
      customBillMessage: row?.customBillMessage ?? null,
      irregularThresholdDays:
        row?.irregularThresholdDays ?? DEFAULT_IRREGULAR_THRESHOLD_DAYS,
      irregularCustomDays: row?.irregularCustomDays ?? null,
      // Single source of truth: the organization's own timezone, never a
      // second stored copy that can drift from it.
      timezone: organization?.timezone ?? 'UTC',
      updatedAt: row?.updatedAt ?? null,
    };
  }

  async update(organizationId: string, dto: UpdateWhatsappProfileDto) {
    validateProfile(dto);
    const data: {
      salutation?: string;
      autoResend?: boolean;
      maxResendAttempts?: number;
      defaultCountryCode?: string;
      customBillMessage?: string | null;
      irregularThresholdDays?: number;
      irregularCustomDays?: number | null;
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
    // A body with no fields changes nothing -- answer the current state
    // without writing a row for it.
    if (Object.keys(data).length === 0) {
      return this.get(organizationId);
    }
    await this.prisma.whatsappProfile.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
    return this.get(organizationId);
  }
}

/** Service-level check so direct callers get the same rejects as the
 * DTO-validated HTTP route. */
export function validateProfile(dto: UpdateWhatsappProfileDto): void {
  if (dto.customBillMessage !== undefined && dto.customBillMessage !== null) {
    const unknown = findUnknownBillVariables(dto.customBillMessage);
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown template variables: ${unknown.join(', ')}. Allowed: ${BILL_VARIABLES.join(', ')}.`,
      );
    }
  }
}
