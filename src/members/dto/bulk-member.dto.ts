import { IsArray, IsOptional, IsString, IsUUID, IsIn } from 'class-validator';
import { MemberStatus } from '@prisma/client';

export class BulkStatusChangeDto {
  @IsArray()
  @IsUUID('4', { each: true })
  memberIds: string[];

  @IsString()
  @IsIn(['ACTIVE', 'INACTIVE', 'FROZEN', 'EXPIRED'])
  status: MemberStatus;
}

export class BulkTagAssignmentDto {
  @IsArray()
  @IsUUID('4', { each: true })
  memberIds: string[];

  @IsArray()
  @IsUUID('4', { each: true })
  tagIds: string[];
}

export class BulkExportDto {
  @IsArray()
  @IsUUID('4', { each: true })
  memberIds: string[];

  @IsOptional()
  @IsString()
  format?: 'csv' | 'xlsx';
}
