import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

export class WorkoutPlanExerciseDto {
  @IsString() exerciseId!: string;
  @IsInt() @Min(1) order!: number;
  @IsInt() @Min(1) sets!: number;
  @IsString() reps!: string;
  @IsOptional() @IsInt() @Min(0) restSeconds?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsInt() @Min(0) @Max(6) dayOfWeek?: number;
}

export class CreateWorkoutPlanDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => WorkoutPlanExerciseDto)
  exercises!: WorkoutPlanExerciseDto[];
}
