import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Manual outreach to a lead over EMAIL or WhatsApp. */
export class SendLeadMessageDto {
  @IsIn(['EMAIL', 'WHATSAPP'])
  channel!: 'EMAIL' | 'WHATSAPP';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @IsString()
  @MaxLength(4000)
  customBody!: string;
}
