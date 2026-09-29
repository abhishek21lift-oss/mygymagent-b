import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Request bodies for the Business OS write routes (B-P1-9).
 *
 * These routes used to take `@Body() b: any`. With no metatype on the
 * parameter the global ValidationPipe has nothing to validate against, so
 * `whitelist`/`forbidNonWhitelisted` did nothing and a misspelt field was
 * accepted and silently dropped -- a journal posted with `date:` instead of
 * `entryDate:` returned 201 and was booked today. Declaring each body is
 * what makes the pipe reject that typo instead.
 *
 * Numbers are deliberately not coerced with `@Type(() => Number)`: these
 * are JSON bodies, so a number arrives as a number, and a string where a
 * number belongs is a client bug worth a 400 rather than a guess.
 *
 * Ids are `@IsString()`, not `@IsUUID()`: the service already turns an id
 * that is not this organization's into a 404, and a malformed id must be
 * indistinguishable from another tenant's.
 */

export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'PENDING',
  'RESOLVED',
  'CLOSED',
] as const;
export const CAMPAIGN_CHANNELS = ['EMAIL', 'WHATSAPP', 'SMS'] as const;
export const ACCOUNTING_ACCOUNT_TYPES = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'EXPENSE',
] as const;

/* ------------------------------------------------------------------ loyalty */

export class AdjustLoyaltyDto {
  /** Non-zero is enforced by the service, which owns that rule. */
  @IsInt()
  points!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class ConvertReferralDto {
  @IsString()
  @IsNotEmpty()
  memberId!: string;
}

/* ------------------------------------------------------------------ support */

export class CreateSupportTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: (typeof TICKET_PRIORITIES)[number];

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  memberId?: string;
}

export class AddTicketMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body!: string;
}

export class UpdateTicketStatusDto {
  @IsIn(TICKET_STATUSES)
  status!: (typeof TICKET_STATUSES)[number];
}

/* ----------------------------------------------------------------- feedback */

export class CreateSurveyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  /** Free text on purpose: the UI offers CSAT/NPS but stores what it gets. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  kind?: string;
}

export class RespondFeedbackDto {
  @IsString()
  @IsNotEmpty()
  surveyId!: string;

  @IsString()
  @IsNotEmpty()
  memberId!: string;

  /** `FeedbackResponse.score` is an Int column; a fraction used to 500. */
  @IsInt()
  @Min(0)
  @Max(10)
  score!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

/* ---------------------------------------------------------------- marketing */

export class CreateCampaignDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsIn(CAMPAIGN_CHANNELS)
  channel?: (typeof CAMPAIGN_CHANNELS)[number];

  /** Empty string is allowed and stored as null -- the form sends one. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  templateKey?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  /**
   * Shape only. Its keys are checked by `campaignAudienceWhere` -- the one
   * resolver both preview and enrol use -- so the rule lives in one place.
   */
  @IsOptional()
  @IsObject()
  audienceFilter?: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

/* --------------------------------------------------------------- accounting */

export class CreateAccountingAccountDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsIn(ACCOUNTING_ACCOUNT_TYPES)
  type?: (typeof ACCOUNTING_ACCOUNT_TYPES)[number];
}

export class JournalLineDto {
  @IsString()
  @IsNotEmpty()
  accountId!: string;

  /**
   * One side per line must be positive; which one is the service's check,
   * since it needs both values at once. Two decimal places matches the
   * `Decimal(14, 2)` column, so nothing is rounded away on write.
   */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  debit?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  credit?: number;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;
}

export class PostJournalDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];

  /** Defaults to now. A date-only value (`2026-09-01`) is accepted. */
  @IsOptional()
  @IsDateString()
  entryDate?: string;

  /**
   * A description for the whole posting, used on any line that has none of
   * its own. The accounting form has always sent this; before it was
   * declared here it was dropped and every line was booked as
   * "Journal entry".
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  memo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  referenceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  referenceId?: string;
}
