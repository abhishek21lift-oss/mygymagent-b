import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  newPassword!: string;
}
