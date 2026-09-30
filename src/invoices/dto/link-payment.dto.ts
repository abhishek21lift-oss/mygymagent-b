import { IsString, IsUUID } from 'class-validator';

export class LinkPaymentDto {
  @IsString()
  @IsUUID()
  paymentId!: string;
}
