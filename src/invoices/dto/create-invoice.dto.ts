import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class InvoiceLineDto {
  @IsString()
  @MaxLength(255)
  label!: string;

  /** Unit price -- the extended line total is amount * qty. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;
}

export class InvoiceTaxBreakupDto {
  @IsString()
  @MaxLength(255)
  label!: string;

  /** Informational rate (e.g. 18 for 18%) -- taxTotal comes from `amount`. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  rate?: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;
}

export class CreateInvoiceDto {
  @IsString()
  memberId!: string;

  @IsOptional()
  @IsString()
  membershipId?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines!: InvoiceLineDto[];

  /** Flat discount applied to the subtotal -- never trusted as a total,
   * just an input the server subtracts itself. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discount?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceTaxBreakupDto)
  taxBreakup?: InvoiceTaxBreakupDto[];

  @IsOptional()
  @IsDateString()
  dueAt?: string;

  /** When true, the invoice stays DRAFT (editable scaffolding) instead of
   * being issued immediately. */
  @IsOptional()
  @IsBoolean()
  draft?: boolean;
}
