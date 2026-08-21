import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListDietAssignmentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  memberId?: string;
}
