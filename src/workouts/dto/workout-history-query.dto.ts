import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class WorkoutHistoryQueryDto {
  @IsOptional()
  @IsString()
  exerciseId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
