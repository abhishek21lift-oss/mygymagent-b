import { PartialType } from '@nestjs/mapped-types';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

const ADDRESS_TYPES = ['HOME', 'WORK', 'BILLING', 'OTHER'] as const;

export class CreateMemberAddressDto {
  @IsOptional()
  @IsIn(ADDRESS_TYPES)
  type?: (typeof ADDRESS_TYPES)[number];

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsString()
  @MinLength(1)
  addressLine1!: string;

  @IsOptional()
  @IsString()
  addressLine2?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsString()
  country?: string;
}

export class UpdateMemberAddressDto extends PartialType(
  CreateMemberAddressDto,
) {}
