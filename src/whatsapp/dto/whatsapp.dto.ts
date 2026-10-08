import { IsISO8601, IsOptional, IsString } from 'class-validator';

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

  /** File id (not S3 key) of an uploaded image to send with the text. */
  @IsOptional()
  @IsString()
  mediaKey?: string;

  /** WhatsApp provider id to quote; unknown ids send without a quote. */
  @IsOptional()
  @IsString()
  replyToMessageId?: string;
}

export class TestSendWhatsAppDto {
  /** Recipient phone number in international format, e.g. `15551234567`. */
  @IsString()
  to!: string;
}

export class ScheduleWhatsAppMessageDto {
  @IsString()
  to!: string;

  @IsString()
  text!: string;

  /** ISO datetime with offset, must be in the future. */
  @IsISO8601()
  sendAt!: string;

  @IsOptional()
  @IsString()
  memberId?: string;
}

export class CreateBroadcastDto {
  /** MemberSegment id, org-scoped. */
  @IsString()
  segmentId!: string;

  @IsString()
  text!: string;

  /** File id of an uploaded image, same rules as single sends. */
  @IsOptional()
  @IsString()
  mediaKey?: string;

  /** ISO datetime with offset; absent means send now. */
  @IsOptional()
  @IsISO8601()
  sendAt?: string;
}
