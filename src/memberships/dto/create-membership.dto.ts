import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';

export class CreateMembershipDto {
  @IsString()
  memberId!: string;

  @IsString()
  membershipPlanId!: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsBoolean()
  /** false = record the purchase as PENDING and activate later via
   * POST /memberships/:id/activate. Omitted/true keeps the legacy
   * behaviour of activating immediately. */
  activate?: boolean;

  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;

  @IsOptional()
  @IsNumber()
  discount?: number;

  @IsOptional()
  @IsNumber()
  initialPayment?: number;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;
}
