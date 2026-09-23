import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import { PtSessionStatus, PtSessionType } from '@prisma/client';

export class UpdatePtSessionDto {
  @IsString()
  @IsOptional()
  memberId?: string;

  @IsString()
  @IsOptional()
  trainerId?: string;

  @IsString()
  @IsOptional()
  branchId?: string;

  @Type(() => Date)
  @IsDate()
  @IsOptional()
  startTime?: Date;

  @Type(() => Date)
  @IsDate()
  @IsOptional()
  endTime?: Date;

  @IsEnum(PtSessionType)
  @IsOptional()
  type?: PtSessionType;

  @IsPositive()
  @IsOptional()
  price?: number;

  @IsEnum(PtSessionStatus)
  @IsOptional()
  status?: PtSessionStatus;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  completedAt?: Date;

  @IsOptional()
  @IsString()
  completedByUserId?: string;

  @IsOptional()
  @IsString()
  cancelledByUserId?: string;

  @IsOptional()
  isPaid?: boolean;
}
