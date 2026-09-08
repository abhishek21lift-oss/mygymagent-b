import { PaymentMethod } from '@prisma/client';
import { IsIn, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ChangeMembershipPlanDto {
  @IsUUID()
  newMembershipPlanId!: string;

  @IsIn(['UPGRADE', 'DOWNGRADE'])
  direction!: 'UPGRADE' | 'DOWNGRADE';

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000)
  discount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  initialPayment?: number;

  @IsOptional()
  paymentMethod?: PaymentMethod;
}
