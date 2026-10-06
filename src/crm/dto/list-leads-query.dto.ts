import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import type { LeadStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

const STATUSES: LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'TRIAL',
  'WON',
  'LOST',
];

export class ListLeadsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: LeadStatus;

  @IsOptional()
  @IsString()
  assignedToUserId?: string;

  /** Inclusive start day (org timezone) on Lead.createdAt. */
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  /** Inclusive end day (org timezone) on Lead.createdAt. */
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  /** Narrow to one branch. Only ever a narrowing: an enforced branch
   * scope always wins -- see `effectiveBranch`. */
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
