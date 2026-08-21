import { IsOptional, IsString } from 'class-validator';

export class CreateExerciseDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  muscleGroup?: string;

  @IsOptional()
  @IsString()
  equipment?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  videoUrl?: string;
}
