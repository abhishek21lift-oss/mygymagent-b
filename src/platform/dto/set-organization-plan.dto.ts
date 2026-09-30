import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class SetOrganizationPlanDto {
  /** A `subscription_plans.key`, e.g. `starter`. */
  @IsString()
  @Length(1, 64)
  planKey: string;

  /** How long the paid period runs from today. Defaults to 1. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36)
  months?: number;
}
