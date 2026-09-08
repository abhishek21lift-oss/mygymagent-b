import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateOnlinePaymentIntentDto {
  /** The membership to charge for. Required: the charge amount is
   * derived server-side from this membership's outstanding balance --
   * the client never supplies an amount. */
  @IsUUID('4')
  membershipId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
