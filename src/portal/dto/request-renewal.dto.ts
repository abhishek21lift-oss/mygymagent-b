import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class RequestRenewalDto {
  /** The plan the member wants. Priced server-side from this id -- the
   * amount is never taken from the request. */
  @IsUUID()
  membershipPlanId!: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string;
}
