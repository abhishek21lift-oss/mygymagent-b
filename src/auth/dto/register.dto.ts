import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { NormaliseEmail } from '../../common/transforms/normalise-email';

/** Self-serve signup: creates a brand-new Organization, its first Branch,
 * and the caller as that organization's Owner. Inviting additional staff
 * into an existing organization is a separate flow (users module). */
export class RegisterDto {
  @IsString()
  @MinLength(2)
  organizationName!: string;

  @NormaliseEmail()
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  @MaxLength(128)
  password!: string;

  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;
}
