import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { ToBoolean } from '../../common/transforms/to-boolean.transform';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateInventorySupplierDto {
  @IsString() name!: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() taxId?: string;
}

// PartialType, not a plain extend: this is a PATCH, so a caller that only
// wants to deactivate a supplier must not be forced to resend its name.
export class UpdateInventorySupplierDto extends PartialType(
  CreateInventorySupplierDto,
) {
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class PurchaseOrderItemDto {
  @IsString() productId!: string;
  @IsInt() @IsPositive() orderedQuantity!: number;
  @IsNumber() @Min(0) unitCost!: number;
}

export class CreatePurchaseOrderDto {
  @IsString() supplierId!: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @Type(() => Date) expectedAt?: Date;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items!: PurchaseOrderItemDto[];
}

export class ReceivePurchaseOrderItemDto {
  @IsString() productId!: string;
  @IsInt() @IsPositive() quantity!: number;
}

export class ReceivePurchaseOrderDto {
  @IsOptional() @IsString() branchId?: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceivePurchaseOrderItemDto)
  items!: ReceivePurchaseOrderItemDto[];
}

export class ReturnSaleItemDto {
  @IsString() productId!: string;
  @IsInt() @IsPositive() quantity!: number;
}

export class ReturnSaleDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReturnSaleItemDto)
  items?: ReturnSaleItemDto[];
}

export class TransferItemDto {
  @IsString() productId!: string;
  @IsInt() @IsPositive() quantity!: number;
}

export class CreateInventoryTransferDto {
  @IsString() fromBranchId!: string;
  @IsString() toBranchId!: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransferItemDto)
  items!: TransferItemDto[];
}

export class SaleItemDto {
  @IsString() productId!: string;
  @IsInt() @IsPositive() quantity!: number;
  @IsNumber() @Min(0) unitPrice!: number;
}

export class CreateInventorySaleDto {
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() memberId?: string;
  @IsOptional() @IsString() invoiceId?: string;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsOptional() @IsString() currency?: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items!: SaleItemDto[];
}

export class InventoryQueryDto {
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @ToBoolean() @IsBoolean() activeOnly?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}
