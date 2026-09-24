import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { ToBoolean } from '../../common/transforms/to-boolean.transform';
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

/**
 * Give many members the same membership in one pass.
 *
 * Built for the state the Customer Enquiry import leaves behind: the
 * export carries no plan, price or end date, so the importer deliberately
 * fabricates no `Membership` -- which is correct, and also means 291
 * members can sit marked ACTIVE with nothing behind them to expire,
 * renew or bill. This is how that gets closed without inventing a
 * different plan per person.
 *
 * No `initialPayment` on purpose. The single-membership route takes one,
 * but money that nobody has recorded receiving should not appear in the
 * ledger for 291 people at once; payments stay a per-member act.
 */
export class BulkAssignMembershipDto {
  @IsArray()
  @IsString({ each: true })
  memberIds!: string[];

  @IsString()
  membershipPlanId!: string;

  /** Defaults to today. The plan's `durationDays` sets the end date. */
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  autoRenew?: boolean;

  /** Report what would happen and write nothing. */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  dryRun?: boolean;
}
