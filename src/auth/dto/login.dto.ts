import { IsEmail, IsString, MinLength } from 'class-validator';
import { NormaliseEmail } from '../../common/transforms/normalise-email';

export class LoginDto {
  @NormaliseEmail()
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
