import { IsDateString, IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListFollowUpsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['OPEN', 'COMPLETED', 'ALL'])
  status?: 'OPEN' | 'COMPLETED' | 'ALL';

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
