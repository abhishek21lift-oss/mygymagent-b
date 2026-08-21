import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateMemberFitnessTestDto {
  @IsOptional()
  @IsString()
  assessmentId?: string;

  @IsString()
  @MinLength(1)
  testName!: string;

  @IsNumber()
  value!: number;

  @IsString()
  @MinLength(1)
  unit!: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  recordedAt?: string;
}
