import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class AnalyzeWorkoutProgressArgsDto {
  @IsUUID()
  memberId!: string;

  @IsUUID()
  exerciseId!: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(100)
  limit?: number;
}
