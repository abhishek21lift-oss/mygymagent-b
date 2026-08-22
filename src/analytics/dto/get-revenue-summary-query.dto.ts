import { IsDateString, IsOptional } from 'class-validator';

/// Both optional -- FinanceService.getRevenueSummary() defaults to the
/// current UTC calendar month when omitted, the same "this period" scope
/// a revenue dashboard's default view would need.
export class GetRevenueSummaryQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
