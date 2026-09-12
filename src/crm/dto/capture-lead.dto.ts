import { IsEmail, IsOptional, IsString } from 'class-validator';

export class CaptureLeadDto {
  @IsString()
  firstName!: string;

  @IsString()
  lastName!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  /**
   * Honeypot spam trap: real forms never fill this hidden field. When it
   * arrives non-empty the controller returns a silent 200 without creating
   * anything, so bots can't distinguish rejection from success.
   */
  @IsOptional()
  @IsString()
  website?: string;
}
