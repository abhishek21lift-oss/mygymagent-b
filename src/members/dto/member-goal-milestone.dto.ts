import { PartialType } from '@nestjs/mapped-types';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateMemberGoalMilestoneDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsDateString()
  targetDate?: string;

  @IsOptional()
  @IsNumber()
  value?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateMemberGoalMilestoneDto extends PartialType(
  CreateMemberGoalMilestoneDto,
) {
  @IsOptional()
  @IsDateString()
  achievedAt?: string;
}
