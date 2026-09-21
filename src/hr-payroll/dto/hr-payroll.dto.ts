import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, IsPositive } from 'class-validator';

export const SALARY_TYPES = ['MONTHLY', 'DAILY', 'HOURLY'] as const;
export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;

export class CreateLeaveTypeDto {
  @IsString() @MaxLength(80) name!: string;
  @IsString() @MaxLength(30) code!: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsBoolean() paid?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) annualQuota?: number;
  @IsOptional() @IsBoolean() carryForward?: boolean;
}

export class CreateLeaveRequestDto {
  @IsUUID() staffProfileId!: string;
  @IsUUID() leaveTypeId!: string;
  @IsUUID() branchId!: string;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
  @IsIn(['DAY', 'HALF_DAY']) unit!: 'DAY' | 'HALF_DAY';
  @IsNumber() @IsPositive() @Type(() => Number) days!: number;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class ReviewLeaveDto {
  @IsIn(['APPROVED', 'REJECTED']) status!: 'APPROVED' | 'REJECTED';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class CreatePayrollRunDto {
  @IsDateString() periodStart!: string;
  @IsDateString() periodEnd!: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class PayrollItemAdjustmentDto {
  @IsUUID() staffProfileId!: string;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) overtime?: number;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) incentives?: number;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) deductions?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}
