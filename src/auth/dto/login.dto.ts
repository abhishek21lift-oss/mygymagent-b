import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { NormaliseEmail } from '../../common/transforms/normalise-email';

export class LoginDto {
  @NormaliseEmail()
  @IsEmail()
  email!: string;

  /** Capped like every password field: argon2id costs 64 MiB per hash,
   * and an over-long value is refused with a 400 before it is hashed. */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
