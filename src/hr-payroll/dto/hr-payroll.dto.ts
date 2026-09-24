import { Type } from 'class-transformer';
import { ToBoolean } from '../../common/transforms/to-boolean.transform';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  IsPositive,
} from 'class-validator';

export const SALARY_TYPES = ['MONTHLY', 'DAILY', 'HOURLY'] as const;
export const LEAVE_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;

export class CreateLeaveTypeDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  @IsString()
  @MaxLength(30)
  code!: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsBoolean()
  paid?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  annualQuota?: number;

  @IsOptional()
  @IsBoolean()
  carryForward?: boolean;
}

export class CreateLeaveRequestDto {
  @IsUUID()
  staffProfileId!: string;

  @IsUUID()
  leaveTypeId!: string;

  @IsUUID()
  branchId!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsIn(['DAY', 'HALF_DAY'])
  unit!: 'DAY' | 'HALF_DAY';

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  days!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ReviewLeaveDto {
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CreatePayrollRunDto {
  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class PayrollItemAdjustmentDto {
  @IsUUID()
  staffProfileId!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  overtime?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  incentives?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  deductions?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unpaidLeave?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  regularHours?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * A staff member's payroll settings (B-P1-7).
 *
 * `processPayrollRun` reads exactly these four columns, and until now
 * nothing in the API wrote any of them -- `CreateUserDto`/`UpdateUserDto`
 * expose none, and no other route touched them. On a real deployment a
 * payroll run therefore either found no payroll-enabled staff and 400'd,
 * or computed every payslip from nulls.
 *
 * Every field is optional because this is a PATCH, but the *resulting*
 * state is validated in the service rather than here: whether a rate is
 * required depends on the salary type, and whether either is required
 * depends on `payrollEnabled` -- none of which class-validator can see
 * from the patch alone, since the missing half may already be stored.
 */
export class UpdateStaffPayrollDto {
  @IsOptional()
  @IsBoolean()
  payrollEnabled?: boolean;

  @IsOptional()
  @IsIn(['MONTHLY', 'DAILY', 'HOURLY'])
  salaryType?: 'MONTHLY' | 'DAILY' | 'HOURLY';

  /** Per month for MONTHLY, per day for DAILY. Ignored for HOURLY. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  baseSalary?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  hourlyRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  employeeCode?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;
}

export class ListStaffPayrollQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  // `@ToBoolean()`, never `@Type(() => Boolean)`: the latter is
  // `Boolean(value)`, under which the string "false" arrives as `true`
  // (ADR AI-22 / B-P0-7). This is a query field, so it needs the explicit
  // transform; a JSON body field would just use `@IsBoolean()`.
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  payrollEnabledOnly?: boolean;
}
