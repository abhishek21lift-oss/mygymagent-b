import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CallDirection, CallOutcome, TaskPriority } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class CreateCallLogDto {
  @IsOptional()
  @IsUUID()
  memberId?: string;

  @IsOptional()
  @IsUUID()
  leadId?: string;

  /** Defaults to the number on the member or lead. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsEnum(CallDirection)
  direction?: CallDirection;

  /** Defaults to now. */
  @IsOptional()
  @IsDateString()
  calledAt?: string;

  @IsEnum(CallOutcome)
  outcome!: CallOutcome;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  /** What the member said, in the receptionist's words. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  response?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  internalNotes?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000_000)
  amountDiscussed?: number;

  /** YYYY-MM-DD (the gym's day) or an instant. */
  @IsOptional()
  @IsDateString()
  promisedPaymentDate?: string;

  @IsOptional()
  @IsDateString()
  nextFollowUpAt?: string;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  /** Who the follow-up goes to; the caller when unset. */
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  /** Required for PAYMENT_COMPLETED: the payment that proves it. */
  @IsOptional()
  @IsUUID()
  paymentId?: string;

  /** The worklist task this call was made for. */
  @IsOptional()
  @IsUUID()
  taskId?: string;

  /** Close that task with this call. */
  @IsOptional()
  @IsBoolean()
  completeTask?: boolean;
}

export class UpdateCallLogDto {
  @IsOptional()
  @IsEnum(CallOutcome)
  outcome?: CallOutcome;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  response?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  internalNotes?: string;

  @IsOptional()
  @IsUUID()
  paymentId?: string;
}

export class ListCallLogsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  memberId?: string;

  @IsOptional()
  @IsUUID()
  leadId?: string;

  @IsOptional()
  @IsEnum(CallOutcome)
  outcome?: CallOutcome;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  recordedByUserId?: string;
}
