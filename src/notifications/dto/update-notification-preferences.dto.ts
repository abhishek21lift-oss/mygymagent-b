import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Plain `@IsBoolean()` is the whole gate here, and that is the point.
 *
 * These fields used to need a `RawBoolean()` transform to undo
 * `enableImplicitConversion`, whose boolean conversion is `Boolean(value)`
 * -- so `{"inApp": "false"}` arrived as `true` and a client opting *out*
 * of a category was silently opted *in*. B-P0-7 removed that option
 * globally, so a JSON body now arrives with its real JSON types and
 * `@IsBoolean()` rejects anything that is not a boolean.
 *
 * `notifications-center.e2e-spec.ts` still asserts that `"false"`, `"0"`
 * and `"nope"` all 400, which is what proves the global fix holds.
 */
export class UpdateNotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  inApp?: boolean;

  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @IsBoolean()
  whatsapp?: boolean;

  @IsOptional()
  @IsBoolean()
  sms?: boolean;

  @IsOptional()
  @IsBoolean()
  push?: boolean;
}
