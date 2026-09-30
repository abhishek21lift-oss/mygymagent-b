import { IsEmail, IsOptional } from 'class-validator';
import { NormaliseEmail } from '../../common/transforms/normalise-email';

/** Send (or re-send) a staff member the link to set their password. */
export class GrantAccessDto {
  /** Needed when the staff member has no email yet; replaces a pending
   * invite's address otherwise. */
  @IsOptional()
  @NormaliseEmail()
  @IsEmail()
  email?: string;
}
