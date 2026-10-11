import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

export class PriceEstimateDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  price!: number;

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
  @Type(() => Number)
  @ValidateIf((o) => o.taxMode !== undefined && o.taxMode !== 'none')
  taxRate?: number;

  @IsOptional()
  @IsString()
  currency?: string;
}
