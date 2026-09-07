import {
  IsDate,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import { PtSessionType } from '@prisma/client';

export class BookPtSessionDto {
  @IsString()
  memberId: string;

  @IsString()
  @IsOptional()
  trainerId?: string;

  @IsString()
  branchId: string;

  @IsDate()
  startTime: Date;

  @IsDate()
  endTime: Date;

  @IsEnum(PtSessionType)
  @IsOptional()
  type?: PtSessionType;

  // PtSession.price is Decimal(10,2): reject more than 2 decimal places
  // instead of letting the column silently round 10.999 to 11.00.
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @IsOptional()
  price?: number;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string;
}
