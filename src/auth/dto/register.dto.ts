import { IsEmail, IsString, MinLength } from 'class-validator';

/** Self-serve signup: creates a brand-new Organization, its first Branch,
 * and the caller as that organization's Owner. Inviting additional staff
 * into an existing organization is a separate flow (users module). */
export class RegisterDto {
  @IsString()
  @MinLength(2)
  organizationName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  password!: string;

  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;
}
