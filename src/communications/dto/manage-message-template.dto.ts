import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { CommunicationChannel } from '@prisma/client';

export class ManageMessageTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  key!: string;

  @IsEnum(['EMAIL', 'WHATSAPP', 'SMS', 'PUSH'])
  channel!: CommunicationChannel;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;
}
