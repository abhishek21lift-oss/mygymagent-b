import { IsNumber, IsOptional, IsString } from 'class-validator';

export class RecordPaymentFailureDto {
  @IsOptional()
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
