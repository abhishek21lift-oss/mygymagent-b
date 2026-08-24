import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class LogWorkoutSetDto {
  @IsInt() @Min(1) setNumber!: number;
  @IsOptional() @IsNumber() @Min(0) weightKg?: number;
  @IsOptional() @IsInt() @Min(0) reps?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10) rpe?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) rir?: number;
  @IsOptional() @IsString() tempo?: string;
  @IsOptional() @IsInt() @Min(0) restSeconds?: number;
  @IsOptional() @IsBoolean() completed?: boolean;
  @IsOptional() @IsString() notes?: string;
  /** Client-generated idempotency key for offline/retry-safe writes. */
  @IsOptional() @IsString() clientToken?: string;
}
