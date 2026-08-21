import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class WorkoutPlanExerciseDto {
  @IsString()
  exerciseId!: string;

  @IsInt()
  @Min(1)
  order!: number;

  @IsInt()
  @Min(1)
  sets!: number;

  /** Free text so "8-12", "AMRAP", "30s" etc. are all valid, not just a
   * fixed rep count. */
  @IsString()
  reps!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  restSeconds?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateWorkoutPlanDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkoutPlanExerciseDto)
  exercises!: WorkoutPlanExerciseDto[];
}
