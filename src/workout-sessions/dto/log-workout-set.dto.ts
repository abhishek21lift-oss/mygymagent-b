import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class LogWorkoutSetDto {
  @IsInt()
  @Min(1)
  setNumber!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  weightKg?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  reps?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(10)
  rpe?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
