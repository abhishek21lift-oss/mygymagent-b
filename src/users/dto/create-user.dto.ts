import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  @IsOptional()
  @IsString()
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
  jobTitle?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isTrainer?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specializations?: string[];

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsNumber()
  commissionRate?: number;

  @IsOptional()
  @IsString()
  employeeCode?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;
}
