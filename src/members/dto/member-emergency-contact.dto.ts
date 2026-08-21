import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateMemberEmergencyContactDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(1)
  phone!: string;

  @IsOptional()
  @IsString()
  relationship?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateMemberEmergencyContactDto extends PartialType(
  CreateMemberEmergencyContactDto,
) {}
