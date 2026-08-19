import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class CreateMembershipPlanDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsInt()
  @IsPositive()
  @Type(() => Number)
  durationDays!: number;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  price!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  benefits?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  maxFreezeDays?: number;
}
