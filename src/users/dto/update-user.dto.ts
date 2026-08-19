import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  primaryBranchId?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED', 'DISABLED'])
  status?: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

  @IsOptional()
  @IsString()
  jobTitle?: string;

  @IsOptional()
  @IsBoolean()
  isTrainer?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specializations?: string[];

  @IsOptional()
  @IsString()
  bio?: string;
}
