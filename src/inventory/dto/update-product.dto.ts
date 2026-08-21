import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateProductDto } from './create-product.dto';

// quantityOnHand is intentionally excluded -- once a product exists, stock
// changes must go through StockMovementsService.record() so the ledger
// stays authoritative. Use PATCH /products/:id/stock-movements instead.
export class UpdateProductDto extends PartialType(
  OmitType(CreateProductDto, ['quantityOnHand'] as const),
) {}
