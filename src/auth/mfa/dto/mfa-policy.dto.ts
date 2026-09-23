import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, ValidateIf } from 'class-validator';
import { MfaPolicy } from '@prisma/client';

export class UpdateMfaPolicyDto {
  @IsEnum(MfaPolicy)
  policy!: MfaPolicy;

  /**
   * When enforcement begins. Omit it when switching enforcement on and the
   * service picks the default grace window rather than restricting your
   * admins the same second -- see MfaPolicyService.updatePolicy.
   *
   * `null` is meaningfully different from omitted: it means "enforce now",
   * and has to be sent explicitly.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Date)
  @IsDate()
  graceUntil?: Date | null;
}
