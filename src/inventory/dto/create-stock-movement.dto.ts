/* eslint-disable prettier/prettier */
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  Min,
  IsString,
  NotEquals,
} from 'class-validator';
import { StockMovementType } from '@prisma/client';

export class CreateStockMovementDto {
  @IsEnum(StockMovementType)
  type!: StockMovementType;

  @IsInt()
  @NotEquals(0)
  quantity!: number;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitCost?: number;

  @IsOptional()
  @IsString()
  note?: string;
}
