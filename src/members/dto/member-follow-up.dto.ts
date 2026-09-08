import {
  IsOptional,
  IsString,
  IsDateString,
  IsEnum,
  IsUUID,
  MinLength,
} from 'class-validator';
import { MemberFollowUpPriority } from '@prisma/client';

export class CreateMemberFollowUpDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @IsOptional()
  @IsEnum(MemberFollowUpPriority)
  priority?: MemberFollowUpPriority;

  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;
}

export class UpdateMemberFollowUpDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @IsOptional()
  @IsEnum(MemberFollowUpPriority)
  priority?: MemberFollowUpPriority;

  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;
}

export class CompleteMemberFollowUpDto {
  @IsOptional()
  @IsString()
  note?: string;
}
