import { IsEmail } from 'class-validator';
import { NormaliseEmail } from '../../common/transforms/normalise-email';

export class ForgotPasswordDto {
  @NormaliseEmail()
  @IsEmail()
  email!: string;
}
