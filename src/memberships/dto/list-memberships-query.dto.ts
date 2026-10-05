import { IsDateString, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListMembershipsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  memberId?: string;

  /** Inclusive start day (org timezone) on Membership.createdAt. */
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  /** Inclusive end day (org timezone) on Membership.createdAt. */
  @IsOptional()
  @IsDateString()
  createdTo?: string;
}
