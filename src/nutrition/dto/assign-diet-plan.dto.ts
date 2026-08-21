import { IsDateString, IsOptional, IsString } from 'class-validator';

export class AssignDietPlanDto {
  @IsString()
  memberId!: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
