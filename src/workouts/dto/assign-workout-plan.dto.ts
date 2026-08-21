import { IsDateString, IsOptional, IsString } from 'class-validator';

export class AssignWorkoutPlanDto {
  @IsString()
  memberId!: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
