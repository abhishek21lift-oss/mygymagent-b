import {
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export const APPOINTMENT_TYPES = [
  'TRIAL',
  'CONSULTATION',
  'ASSESSMENT',
  'FOLLOW_UP',
  'PT_SESSION',
  'OTHER',
] as const;

export class CreateAppointmentDto {
  @IsString()
  branchId!: string;

  @IsOptional()
  @IsString()
  staffId?: string;

  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsIn(APPOINTMENT_TYPES)
  type!: (typeof APPOINTMENT_TYPES)[number];

  @IsString()
  @MaxLength(160)
  title!: string;

  @IsDateString()
  startTime!: string;

  @IsDateString()
  endTime!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  clientName?: string;

  @IsOptional()
  @IsEmail()
  clientEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  clientPhone?: string;
}

export class UpdateAppointmentDto {
  @IsOptional()
  @IsString()
  staffId?: string;

  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsIn(APPOINTMENT_TYPES)
  type?: (typeof APPOINTMENT_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsDateString()
  startTime?: string;

  @IsOptional()
  @IsDateString()
  endTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  clientName?: string;

  @IsOptional()
  @IsEmail()
  clientEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  clientPhone?: string;
}

export class RescheduleAppointmentDto {
  @IsDateString()
  startTime!: string;

  @IsDateString()
  endTime!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CancelAppointmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListAppointmentsQueryDto extends PaginationQueryDto {
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

export class CalendarQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  staffId?: string;

  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;
}

export class SetAvailabilityRuleDto {
  @IsString()
  staffId!: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsInt()
  @Min(0)
  @Max(6)
  @Type(() => Number)
  dayOfWeek!: number;

  @IsInt()
  @Min(0)
  @Max(1439)
  @Type(() => Number)
  startMinute!: number;

  @IsInt()
  @Min(1)
  @Max(1440)
  @Type(() => Number)
  endMinute!: number;
}

export class AddTimeOffDto {
  @IsString()
  staffId!: string;

  @IsOptional()
  @IsString()
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
