import { IsIn, IsOptional, IsString } from 'class-validator';

export class CheckInDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  staffUserId?: string;

  @IsOptional()
  @IsString()
  qrToken?: string;

  @IsOptional()
  @IsIn(['QR', 'MANUAL', 'KIOSK', 'APP', 'STAFF', 'BIOMETRIC'])
  method?: 'QR' | 'MANUAL' | 'KIOSK' | 'APP' | 'STAFF' | 'BIOMETRIC';
}
