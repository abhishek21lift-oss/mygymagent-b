import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
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
  autoRenew?: boolean;

  /** Off the plan price; never more than the price itself (checked in
   * the service, which knows the plan). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discount?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  initialPayment?: number;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  /**
   * Start the plan's free trial instead of a paid term. Requires the
   * plan to offer trialDays; at most one trial per member per org.
   */
  @IsOptional()
  @IsBoolean()
  isTrial?: boolean;
}
