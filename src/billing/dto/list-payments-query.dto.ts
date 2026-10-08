import { IsOptional, IsString, Matches } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListPaymentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  membershipId?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  /** A day on the gym's calendar (YYYY-MM-DD), in its own timezone --
   * the same day the dashboard's Today figures count. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
