import { IsIn, IsOptional, IsString, IsObject } from 'class-validator';

export class SendMemberMessageDto {
  @IsString()
  @IsIn(['EMAIL', 'WHATSAPP', 'SMS', 'PUSH'])
  channel!: 'EMAIL' | 'WHATSAPP' | 'SMS' | 'PUSH';

  @IsOptional()
  @IsString()
  templateKey?: string;

  @IsOptional()
  @IsString()
  customBody?: string;

  @IsOptional()
  @IsString()
  customSubject?: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}
