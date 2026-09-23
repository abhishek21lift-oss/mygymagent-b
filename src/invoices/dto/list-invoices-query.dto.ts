import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { InvoiceStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ToBoolean } from '../../common/transforms/to-boolean.transform';

export class ListInvoicesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @IsOptional()
  @IsString()
  memberId?: string;

  /** Only invoices past their due date that are still collectible
   * (ISSUED/PART_PAID). Accepts `?overdue=true`. */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  overdue?: boolean;
}
