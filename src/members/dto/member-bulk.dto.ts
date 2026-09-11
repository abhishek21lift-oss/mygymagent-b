import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import type { MemberStatus } from '@prisma/client';

const STATUSES: MemberStatus[] = ['ACTIVE', 'INACTIVE', 'FROZEN', 'EXPIRED'];

export class BulkStatusChangeDto {
  @IsArray()
  @IsString({ each: true })
  memberIds!: string[];

  @IsIn(STATUSES)
  status!: MemberStatus;
}

export class BulkTagAssignmentDto {
  @IsArray()
  @IsString({ each: true })
  memberIds!: string[];

  @IsArray()
  @IsString({ each: true })
  tagIds!: string[];
}

export class BulkExportDto {
  @IsArray()
  @IsString({ each: true })
  memberIds!: string[];

  @IsOptional()
  @IsIn(['csv', 'xlsx'])
  format?: 'csv' | 'xlsx';
}
