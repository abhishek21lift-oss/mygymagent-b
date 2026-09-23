import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ExerciseHistoryQueryDto {
  @IsUUID()
  memberId!: string;

  @IsUUID()
  exerciseId!: string;

  // Query params are always strings, so the conversion has to be
  // explicit now that `enableImplicitConversion` is gone (B-P0-7).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
