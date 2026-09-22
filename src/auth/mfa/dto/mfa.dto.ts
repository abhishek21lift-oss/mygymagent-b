import { IsString, Length, MaxLength, MinLength } from 'class-validator';

export class ConfirmMfaDto {
  /** The 6-digit code from the authenticator app. */
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class DisableMfaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;

  /** A current 6-digit code, or an unused recovery code. */
  @IsString()
  @MinLength(6)
  @MaxLength(40)
  code!: string;
}

export class VerifyMfaDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  mfaToken!: string;

  /** A current 6-digit code, or an unused recovery code. */
  @IsString()
  @MinLength(6)
  @MaxLength(40)
  code!: string;
}
