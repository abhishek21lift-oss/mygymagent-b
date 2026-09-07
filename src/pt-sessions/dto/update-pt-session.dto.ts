import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsNumber,
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

  @IsDate()
  @IsOptional()
  startTime?: Date;

  @IsDate()
  @IsOptional()
  endTime?: Date;

  @IsEnum(PtSessionType)
  @IsOptional()
  type?: PtSessionType;

  // PtSession.price is Decimal(10,2): reject more than 2 decimal places.
  @IsNumber({ maxDecimalPlaces: 2 })
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

  @IsBoolean()
  @IsOptional()
  isPaid?: boolean;
}
