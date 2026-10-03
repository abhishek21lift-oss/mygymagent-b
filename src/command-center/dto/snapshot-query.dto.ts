import { IsIn, IsOptional, IsString } from 'class-validator';

/**
 * `refresh` arrives as a query string, so it is validated as one and
 * interpreted by an explicit comparison — never coerced with
 * `Boolean(value)`, which is true for ANY non-empty string including the
 * text "false". Same trap as the `SMTP_SECURE` env var (see
 * env.validation.ts) and the reason main.ts deliberately does not set
 * `enableImplicitConversion`.
 *
 * Anything other than "true" or "false" is a 400 rather than a shrug, so a
 * client bug shows up as an error instead of silently never refreshing.
 */
export class SnapshotQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  refresh?: string;

  get refreshRequested(): boolean {
    return this.refresh === 'true';
  }
}
