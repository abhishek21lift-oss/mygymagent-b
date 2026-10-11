import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const PLAN_BENEFIT_MAX_ITEMS = 20;
export const PLAN_BENEFIT_MAX_LENGTH = 80;
export const PLAN_DESCRIPTION_MAX_LENGTH = 2000;
export const PLAN_TERMS_MAX_LENGTH = 10000;
export const PLAN_FAQS_MAX_ITEMS = 10;
export const PLAN_FAQ_TEXT_MAX_LENGTH = 300;
export const PLAN_APPOINTMENT_TYPES_MAX_ITEMS = 10;

/**
 * ISO-4217 membership billing is validated against the platform's
 * supported currency list rather than a hardcoded table, so newly
 * supported currencies never need a code change here.
 */
export function isSupportedCurrency(code: string): boolean {
  if (typeof Intl.supportedValuesOf !== 'function')
    return /^[A-Z]{3}$/.test(code);
  try {
    return (Intl.supportedValuesOf('currency') as string[]).includes(code);
  } catch {
    return /^[A-Z]{3}$/.test(code);
  }
}

export class PlanFaqDto {
  @IsString()
  @MaxLength(PLAN_FAQ_TEXT_MAX_LENGTH)
  q!: string;

  @IsString()
  @MaxLength(PLAN_FAQ_TEXT_MAX_LENGTH)
  a!: string;
}

export class CreateMembershipPlanDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(PLAN_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsInt()
  @IsPositive()
  @Type(() => Number)
  durationDays!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  price!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PLAN_BENEFIT_MAX_ITEMS)
  @IsString({ each: true })
  @MaxLength(PLAN_BENEFIT_MAX_LENGTH, { each: true })
  benefits?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  maxFreezeDays?: number;

  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  displayOrder?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  trialDays?: number;

  /** Was-price display. Must exceed the list price when set. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  compareAtPrice?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  joiningFee?: number;

  @IsOptional()
  @IsIn(['none', 'inclusive', 'exclusive'])
  taxMode?: 'none' | 'inclusive' | 'exclusive';

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(28)
  @Type(() => Number)
  @ValidateIf((o) => o.taxMode !== undefined && o.taxMode !== 'none')
  taxRate?: number;

  /**
   * Null = unlimited classes. Zero is rejected: a limit of zero is
   * indistinguishable from unlimited at the booking gate, so the
   * form sends null instead.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  weeklyClassLimit?: number;

  /** Included PT sessions. Zero = none. Granted as PtPackage rows. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  ptSessionCredits?: number;

  /** Display labels only in v1; booking does not enforce them. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PLAN_APPOINTMENT_TYPES_MAX_ITEMS)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  appointmentTypes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(PLAN_TERMS_MAX_LENGTH)
  termsAndConditions?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PLAN_FAQS_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => PlanFaqDto)
  faqs?: PlanFaqDto[];

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @MaxLength(500)
  imageUrl?: string;
}
