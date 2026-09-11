import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { CommunicationChannel } from '@prisma/client';

const CHANNELS: CommunicationChannel[] = ['EMAIL', 'WHATSAPP', 'SMS', 'PUSH'];

export class SendMemberMessageDto {
  @IsIn(CHANNELS)
  channel!: CommunicationChannel;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  templateKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  customBody?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  customSubject?: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}
