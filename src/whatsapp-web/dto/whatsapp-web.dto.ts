import {
  Equals,
  IsBoolean,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class ConnectWhatsappWebDto {
  /** The owner's explicit acceptance that WhatsApp may ban a number
   * linked this way. Must be literally `true`. */
  @Equals(true, {
    message: 'Accept the risk of using WhatsApp Web before linking a number',
  })
  acceptRisk: true;

  /** Link with an 8-character pairing code for this number instead of
   * scanning a QR -- digits with country code, e.g. 919812345678. */
  @IsOptional()
  @Matches(/^\d{11,15}$/, {
    message:
      'phoneNumber must be digits with the country code, e.g. 919812345678',
  })
  phoneNumber?: string;
}

export class UpdateWhatsappWebSettingsDto {
  @IsOptional()
  @IsBoolean()
  useForSending?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  dailyLimit?: number;
}
