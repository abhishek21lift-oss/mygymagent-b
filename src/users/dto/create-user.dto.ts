import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { NormaliseEmail } from '../../common/transforms/normalise-email';
import { SALARY_TYPES } from '../../hr-payroll/dto/hr-payroll.dto';

/**
 * How a new staff member gets into the app.
 *
 * - INVITE: emailed a link to set their own password (the original flow).
 * - PASSWORD: the owner sets one now and hands it over; they can sign in
 *   straight away.
 * - NONE: on the roster for payroll, attendance and PT, with no login --
 *   a cleaner, a front-desk helper without a phone. No email is taken,
 *   so no password can ever be reset onto the account; access is given
 *   later through `POST /users/:id/invite`.
 */
export const STAFF_ACCESS = ['INVITE', 'PASSWORD', 'NONE'] as const;
export type StaffAccess = (typeof STAFF_ACCESS)[number];

/** Pay settings set as the staff member is added. Needs `hr.manage`. */
export class StaffPayDto {
  @IsIn(SALARY_TYPES)
  salaryType!: (typeof SALARY_TYPES)[number];

  /** Per month for MONTHLY, per day for DAILY. */
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

  /** Include in payroll runs. Defaults to true when pay is given. */
  @IsOptional()
  @IsBoolean()
  payrollEnabled?: boolean;
}

export class CreateUserDto {
  @IsOptional()
  @IsIn(STAFF_ACCESS)
  access?: StaffAccess;

  /** Required unless `access` is NONE, when it must be left out. */
  @ValidateIf(
    (o: CreateUserDto) => o.access !== 'NONE' || o.email !== undefined,
  )
  @NormaliseEmail()
  @IsEmail()
  email?: string;

  /** Only with `access: PASSWORD`. Same rule as sign-up. */
  @ValidateIf((o: CreateUserDto) => o.access === 'PASSWORD')
  @IsString()
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  @MaxLength(128)
  password?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  primaryBranchId?: string;

  /** Key from ROLES_CATALOG (or a custom org role key), e.g. "TRAINER". */
  @IsString()
  roleKey!: string;

  /** Scopes the role assignment to one branch; omit for an org-wide grant. */
  @IsOptional()
  @IsString()
  roleBranchId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  jobTitle?: string;

  @IsOptional()
  @IsBoolean()
  isTrainer?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  specializations?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bio?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  commissionRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  employeeCode?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => StaffPayDto)
  pay?: StaffPayDto;
}
