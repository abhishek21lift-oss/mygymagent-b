import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum WorkoutSessionStatus {
  SCHEDULED = 'SCHEDULED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  SKIPPED = 'SKIPPED',
  NO_SHOW = 'NO_SHOW',
  CANCELLED = 'CANCELLED',
}

export class UpdateWorkoutSessionDto {
  @IsEnum(WorkoutSessionStatus)
  status!: WorkoutSessionStatus;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}
