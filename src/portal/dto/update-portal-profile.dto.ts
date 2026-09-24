import { IsOptional, IsString, Length, Matches } from 'class-validator';

/**
 * What a member may change about themselves.
 *
 * Contact details only, and the omissions are the design. `email` is the
 * login identity -- changing it here would silently move the account,
 * bypassing the verification the staff flow does. `firstName`/`lastName`
 * feed duplicate detection and the gym's own records. `status`,
 * `primaryBranchId`, `assignedTrainerId`, `memberType` and anything
 * about a membership are commercial decisions that belong to the gym.
 *
 * A DTO that listed everything and filtered later would put one missed
 * `delete dto.x` between a member and their own membership status, so
 * the allowed set is the type.
 */
export class UpdatePortalProfileDto {
  @IsOptional()
  @IsString()
  @Length(5, 32)
  // Deliberately permissive: members travel, and gyms take international
  // numbers. This rejects obvious junk, not unfamiliar dialling plans.
  @Matches(/^[+()\-\s\d]+$/, {
    message: 'phone may only contain digits, spaces and + ( ) -',
  })
  phone?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  emergencyContactName?: string;

  @IsOptional()
  @IsString()
  @Length(5, 32)
  @Matches(/^[+()\-\s\d]+$/, {
    message:
      'emergencyContactPhone may only contain digits, spaces and + ( ) -',
  })
  emergencyContactPhone?: string;

  @IsOptional()
  @IsString()
  @Length(1, 190)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @Length(1, 190)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  city?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  state?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20)
  postalCode?: string;
}
