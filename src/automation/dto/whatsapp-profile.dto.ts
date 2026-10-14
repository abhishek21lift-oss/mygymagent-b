import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SALUTATIONS } from '../../communications/salutation';

export const IRREGULAR_PRESETS = [3, 7, 15, 30] as const;

export class UpdateWhatsappAutomationProfileDto {
  @IsOptional()
  @IsIn([...SALUTATIONS])
  salutation?: string;

  @IsOptional()
  @IsBoolean()
  autoResend?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  maxResendAttempts?: number;

  @IsOptional()
  @Matches(/^\d{1,4}$/, {
    message: 'defaultCountryCode must be 1-4 digits, e.g. 91',
  })
  defaultCountryCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  customBillMessage?: string | null;

  @IsOptional()
  @IsInt()
  @IsIn([...IRREGULAR_PRESETS])
  irregularThresholdDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  irregularCustomDays?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
