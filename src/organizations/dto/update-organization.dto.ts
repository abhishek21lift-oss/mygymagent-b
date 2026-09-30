import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Blank text clears a field: "" arrives as null. */
const blankToNull = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  );

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  /** An IANA zone such as "Asia/Kolkata" -- every date the gym sends and
   * shows is read in it, so a typo here shifted them all. */
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be a 3-letter code such as INR',
  })
  currency?: string;

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @IsOptional()
  @blankToNull()
  @Matches(/^\+?[0-9][0-9 ()-]{5,19}$/, {
    message: 'contactPhone must be a phone number',
  })
  contactPhone?: string | null;

  @IsOptional()
  @blankToNull()
  @IsEmail()
  @MaxLength(200)
  contactEmail?: string | null;

  @IsOptional()
  @blankToNull()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(300)
  website?: string | null;

  /** The handle, with or without "@"; stored without it. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const handle = value.trim().replace(/^@/, '');
    return handle === '' ? null : handle;
  })
  @Matches(/^[A-Za-z0-9._]{1,30}$/, {
    message: 'instagram must be a handle such as the.cult.gym',
  })
  instagram?: string | null;

  /** Name members see as the sender of the gym's emails. */
  @IsOptional()
  @blankToNull()
  @IsString()
  @MaxLength(80)
  emailFromName?: string | null;

  /** Where members' replies to the gym's emails go. */
  @IsOptional()
  @blankToNull()
  @IsEmail()
  @MaxLength(200)
  emailReplyTo?: string | null;
}
