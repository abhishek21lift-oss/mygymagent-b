import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `kind` decides which ingest route the issued key works on, so it is
 * part of registration rather than something the check-in route infers.
 * It defaults to KIOSK, which is what every device registered before
 * B-P0-13 was.
 */
export class RegisterDeviceDto {
  @IsString()
  branchId!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsEnum(['KIOSK', 'BIOMETRIC'])
  kind?: 'KIOSK' | 'BIOMETRIC';
}

export class ListDevicesQueryDto {
  @IsOptional()
  @IsString()
  branchId?: string;
}

export class KioskCheckInDto {
  @IsString()
  deviceKey!: string;

  @IsString()
  memberId!: string;
}
