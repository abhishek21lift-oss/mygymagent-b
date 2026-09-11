import {
  IsCurrency,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export const EXPENSE_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAID',
] as const;

/// Conventional categories shown in the finance UI's picker. Stored as
/// free text (a gym's chart of accounts is theirs, not ours) -- the
/// summary endpoint groups by whatever was actually recorded.
export const EXPENSE_CATEGORIES = [
  'RENT',
  'SALARIES',
  'UTILITIES',
  'MARKETING',
  'EQUIPMENT',
  'MAINTENANCE',
  'SUPPLIES',
  'OTHER',
] as const;

export class CreateExpenseDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsString()
  @MaxLength(60)
  category!: string;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  amount!: number;

  @IsOptional()
  @IsCurrency()
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  vendor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  billNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsDateString()
  expenseDate?: string;
}

export class UpdateExpenseDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  amount?: number;

  @IsOptional()
  @IsCurrency()
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  vendor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  billNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsDateString()
  expenseDate?: string;
}

export class RejectExpenseDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListExpensesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsIn(EXPENSE_STATUSES)
  status?: (typeof EXPENSE_STATUSES)[number];

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class ExpenseSummaryQueryDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
