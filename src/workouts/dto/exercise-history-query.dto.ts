import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ExerciseHistoryQueryDto {
  @IsUUID()
  memberId!: string;

  @IsUUID()
  exerciseId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
