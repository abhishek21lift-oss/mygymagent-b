import { PartialType } from '@nestjs/mapped-types';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

const GOAL_CATEGORIES = [
  'WEIGHT_LOSS',
  'MUSCLE_GAIN',
  'STRENGTH',
  'ENDURANCE',
  'GENERAL_FITNESS',
  'OTHER',
] as const;

const GOAL_STATUSES = ['ACTIVE', 'ACHIEVED', 'ABANDONED', 'PAUSED'] as const;

export class CreateMemberGoalDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(GOAL_CATEGORIES)
  category?: (typeof GOAL_CATEGORIES)[number];

  @IsOptional()
  @IsNumber()
  targetValue?: number;

  @IsOptional()
  @IsString()
  targetUnit?: string;

  @IsOptional()
  @IsNumber()
  baselineValue?: number;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  targetDate?: string;
}

export class UpdateMemberGoalDto extends PartialType(CreateMemberGoalDto) {
  @IsOptional()
  @IsIn(GOAL_STATUSES)
  status?: (typeof GOAL_STATUSES)[number];
}
