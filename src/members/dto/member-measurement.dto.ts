import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateMemberMeasurementDto {
  @IsOptional()
  @IsString()
  assessmentId?: string;

  @IsOptional()
  @IsDateString()
  recordedAt?: string;

  @IsOptional()
  @IsNumber()
  weightKg?: number;

  @IsOptional()
  @IsNumber()
  heightCm?: number;

  @IsOptional()
  @IsNumber()
  bodyFatPercent?: number;

  @IsOptional()
  @IsNumber()
  muscleMassKg?: number;

  @IsOptional()
  @IsNumber()
  waistCm?: number;

  @IsOptional()
  @IsNumber()
  hipCm?: number;

  @IsOptional()
  @IsNumber()
  chestCm?: number;

  @IsOptional()
  @IsInt()
  restingHeartRate?: number;

  @IsOptional()
  @IsInt()
  bloodPressureSystolic?: number;

  @IsOptional()
  @IsInt()
  bloodPressureDiastolic?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
