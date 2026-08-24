import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateWorkoutSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
