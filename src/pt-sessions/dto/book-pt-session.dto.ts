import {
  IsDate,
  IsEnum,
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

  @IsPositive()
  @IsOptional()
  price?: number;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string;
}
