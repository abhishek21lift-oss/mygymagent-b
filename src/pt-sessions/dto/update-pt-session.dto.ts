import {
  IsDate,
  IsEnum,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import { PtSessionStatus, PtSessionType } from '../pt-session.entity';

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
}
