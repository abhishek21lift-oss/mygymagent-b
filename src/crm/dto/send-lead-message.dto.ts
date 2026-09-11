import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendLeadMessageDto {
  @IsIn(['EMAIL', 'WHATSAPP'])
  channel!: 'EMAIL' | 'WHATSAPP';

  @IsString()
  @MaxLength(5000)
  customBody!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;
}
