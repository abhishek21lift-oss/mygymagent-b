import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import type { PaymentMethod } from '@prisma/client';

const METHODS: PaymentMethod[] = [
  'CASH',
  'CARD',
  'UPI',
  'BANK_TRANSFER',
  'OTHER',
];

export class CreatePaymentDto {
  @IsString()
  memberId!: string;

  @IsOptional()
  @IsString()
  membershipId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsIn(METHODS)
  method?: PaymentMethod;

  @IsOptional()
  @IsString()
  note?: string;
}
