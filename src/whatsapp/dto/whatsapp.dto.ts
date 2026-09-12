import { IsOptional, IsString } from 'class-validator';

export class CompleteEmbeddedSignupDto {
  /** Short-lived code from Meta's embedded-signup FB.login callback. */
  @IsString()
  code!: string;

  /** WhatsApp Business Account id selected during onboarding. */
  @IsString()
  wabaId!: string;

  /** Phone number id selected during onboarding, if any. */
  @IsOptional()
  @IsString()
  phoneNumberId?: string;
}

export class SendWhatsAppMessageDto {
  @IsString()
  to!: string;

  @IsString()
  text!: string;
}

export class TestSendWhatsAppDto {
  /** Recipient phone number in international format, e.g. `15551234567`. */
  @IsString()
  to!: string;
}
