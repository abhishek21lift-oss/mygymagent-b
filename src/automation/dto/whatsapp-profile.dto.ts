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

export const SALUTATIONS = [
  'Dear',
  'Hello',
  'Respected',
  'Hi',
  'Hey',
  'Greetings',
] as const;
export type Salutation = (typeof SALUTATIONS)[number];

/** Template variables the bill-message renderer resolves. Anything else
 * in a custom message is rejected, matching the exact hint the settings
 * UI shows -- so a typo fails loudly at save time, not silently at send
 * time when a member is waiting for an invoice. */
export const BILL_VARIABLES = [
  '{{firstName}}',
  '{{organizationName}}',
  '{{salutation}}',
  '{{invoiceNumber}}',
  '{{amount}}',
  '{{currency}}',
  '{{dueState}}',
  '{{dueDate}}',
] as const;

/** Every `{{token}}` in the text must be a known variable. Plain text
 * (no tokens at all) is fine; unknown tokens are not. */
export function findUnknownBillVariables(text: string): string[] {
  const tokens = text.match(/\{\{[A-Za-z]+\}\}/g) ?? [];
  return [
    ...new Set(
      tokens.filter(
        (t) => !BILL_VARIABLES.includes(t as (typeof BILL_VARIABLES)[number]),
      ),
    ),
  ];
}

export class UpdateWhatsappProfileDto {
  @IsOptional()
  @IsIn([...SALUTATIONS])
  salutation?: Salutation;

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
    message: 'defaultCountryCode must be 1-4 digits, e.g. 91.',
  })
  defaultCountryCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  customBillMessage?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  irregularThresholdDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  irregularCustomDays?: number | null;
}
