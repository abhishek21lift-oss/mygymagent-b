import { IsString, MaxLength } from 'class-validator';

export class RegisterKioskDto {
  @IsString()
  branchId!: string;

  @IsString()
  @MaxLength(120)
  name!: string;
}

export class KioskCheckInDto {
  @IsString()
  deviceKey!: string;

  @IsString()
  memberId!: string;
}
