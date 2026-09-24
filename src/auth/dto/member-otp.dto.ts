import { IsString, Length, Matches } from 'class-validator';

export class RequestOtpDto {
  /** As typed: `9876543210` or `+919876543210` both resolve, since the
   * lookup compares the last ten digits. */
  @IsString()
  @Matches(/^\+?[0-9\s-]{10,20}$/, { message: 'Enter a valid phone number' })
  phone!: string;
}

export class VerifyOtpDto {
  @IsString()
  @Matches(/^\+?[0-9\s-]{10,20}$/, { message: 'Enter a valid phone number' })
  phone!: string;

  @IsString()
  @Length(6, 6, { message: 'The code is 6 digits' })
  @Matches(/^[0-9]{6}$/, { message: 'The code is 6 digits' })
  code!: string;
}
