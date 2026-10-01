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

/**
 * Exactly one way of naming the member, checked in the service: the
 * member's id (what every kiosk sent before the self-service screen), the
 * member code printed on their card, or the token encoded in the check-in
 * QR the member portal shows. A QR token is resolved through the same
 * hashed `MemberQrToken` lookup the front desk uses.
 */
export class KioskCheckInDto {
  @IsString()
  @MaxLength(256)
  deviceKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  memberId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  memberCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  qrToken?: string;
}

/** A kiosk asking who it is. The key is the only input and the only
 * credential, the same as on check-in. */
export class KioskSessionDto {
  @IsString()
  @MaxLength(256)
  deviceKey!: string;
}
