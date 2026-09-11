import { IsNumber, IsOptional, IsString } from 'class-validator';

export class ChangePlanDto {
  @IsString()
  membershipPlanId!: string;

  @IsOptional()
  @IsNumber()
  discount?: number;

  @IsOptional()
  @IsNumber()
  initialPayment?: number;

  @IsOptional()
  @IsString()
  paymentMethod?: string;
}
