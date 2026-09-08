import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class MembershipPlanChangeDto {
  @IsString()
  membershipPlanId!: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  initialPayment?: number;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsNumber()
  discount?: number;
}

export class ExtendMembershipDto {
  @IsNumber()
  @IsPositive()
  days!: number;
}

export class TransferMembershipDto {
  @IsString()
  memberId!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class PauseMembershipDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  days?: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class PaymentFailureDto {
  @IsOptional()
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsDateString()
  attemptedAt?: string;
}

export class ReminderQueryDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  days?: number;
}
