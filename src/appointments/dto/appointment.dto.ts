import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AppointmentType } from '@prisma/client';

export class CreateAppointmentDto {
  @IsUUID()
  branchId!: string;

  @IsUUID()
  @IsOptional()
  staffId?: string;

  @IsUUID()
  @IsOptional()
  memberId?: string;

  @IsUUID()
  @IsOptional()
  leadId?: string;

  @IsEnum(AppointmentType)
  type!: AppointmentType;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title!: string;

  @IsDateString()
  startTime!: string;

  @IsDateString()
  endTime!: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;

  /// Optional client contact for reminder delivery; defaults from the
  /// linked member/lead when omitted.
  @IsString()
  @IsOptional()
  @MaxLength(120)
  clientName?: string;

  @IsEmail()
  @IsOptional()
  clientEmail?: string;

  @IsString()
  @IsOptional()
  @MaxLength(32)
  clientPhone?: string;
}

export class UpdateAppointmentDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title?: string;

  @IsDateString()
  @IsOptional()
  startTime?: string;

  @IsDateString()
  @IsOptional()
  endTime?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}

export class RescheduleAppointmentDto {
  @IsDateString()
  startTime!: string;

  @IsDateString()
  endTime!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class CancelAppointmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListAppointmentsQueryDto {
  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  staffId?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class AvailabilityRuleDto {
  @IsUUID()
  staffId!: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @IsInt()
  @Min(0)
  @Max(1439)
  startMinute!: number;

  @IsInt()
  @Min(1)
  @Max(1440)
  endMinute!: number;
}

export class TimeOffDto {
  @IsUUID()
  staffId!: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsDateString()
  startAt!: string;

  @IsDateString()
  endAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
