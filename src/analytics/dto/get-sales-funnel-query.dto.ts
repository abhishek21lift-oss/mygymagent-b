import { BranchFilterQueryDto } from '../../common/branch/branch-filter';
import { IsDateString, IsOptional } from 'class-validator';

/// Both optional -- omitted means all-time, unlike GetRevenueSummaryQueryDto
/// which defaults to the current month. A funnel is naturally read as a
/// cumulative/all-time view by default; "this month's funnel" is an
/// explicit narrower query, not the default one.
export class GetSalesFunnelQueryDto extends BranchFilterQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
