import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  NotEquals,
} from 'class-validator';
import { StockMovementType } from '@prisma/client';

export class CreateStockMovementDto {
  @IsEnum(StockMovementType)
  type!: StockMovementType;

  // For RESTOCK/SALE/DAMAGED this is the (positive) count of units moved;
  // the service applies the sign based on `type`. For ADJUSTMENT it is the
  // signed correction to apply directly. Either way it must be non-zero --
  // see InventoryService.recordMovement().
  @IsInt()
  @NotEquals(0)
  quantity!: number;

  @IsOptional()
  @IsString()
  note?: string;
}
