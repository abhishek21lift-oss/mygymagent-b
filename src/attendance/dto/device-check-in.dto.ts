import { IsOptional, IsString } from 'class-validator';

export class DeviceCheckInDto {
  @IsString()
  deviceKey!: string;

  @IsString()
  externalUserId!: string;

  @IsOptional()
  @IsString()
  at?: string;
}
