import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Returns the *raw* request value instead of the implicitly-converted one.
 *
 * `main.ts` enables class-transformer's `enableImplicitConversion`, whose
 * boolean conversion is `Boolean(value)` -- so every non-empty string
 * becomes `true`, including `"false"` and `"0"`. Without this, a client
 * sending `{"inApp": "false"}` to opt *out* of a notification category is
 * silently opted *in*, and `@IsBoolean()` never sees a value it could
 * reject. Passing the untouched value through keeps `@IsBoolean()` as the
 * real gate: genuine booleans pass, everything else is a 400.
 *
 * Same bug class as `SMTP_SECURE` in ARCHITECTURE_DECISIONS.md AI-7. The
 * other 18 `@IsBoolean()` fields in this codebase still have the hole --
 * see B-P0-7 in BACKLOG.md.
 */
const RawBoolean = () =>
  Transform(
    ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key],
  );

export class UpdateNotificationPreferencesDto {
  @IsOptional()
  @RawBoolean()
  @IsBoolean()
  inApp?: boolean;

  @IsOptional()
  @RawBoolean()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @RawBoolean()
  @IsBoolean()
  whatsapp?: boolean;

  @IsOptional()
  @RawBoolean()
  @IsBoolean()
  sms?: boolean;

  @IsOptional()
  @RawBoolean()
  @IsBoolean()
  push?: boolean;
}
