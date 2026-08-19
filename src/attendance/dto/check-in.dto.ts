import { IsIn, IsOptional, IsString } from 'class-validator';

export class CheckInDto {
  @IsString()
  branchId!: string;

  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  staffUserId?: string;

  @IsOptional()
  @IsIn(['QR', 'MANUAL', 'KIOSK', 'APP', 'STAFF'])
  method?: 'QR' | 'MANUAL' | 'KIOSK' | 'APP' | 'STAFF';
}
