import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListStockMovementsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  productId?: string;
}
