import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Maps a turnstile's own identifier for a person (the `externalUserId` the
 * scanner sends when a finger or card is read) to a member.
 *
 * Deliberately branch-scoped rather than device-scoped: `DeviceMap`'s
 * unique key is `(organizationId, branchId, externalUserId)`, because a
 * branch's scanners share one enrolment database. Enrolling a member once
 * admits them at every turnstile on that branch, which is what a gym
 * expects and what the hardware does.
 */
export class CreateDeviceEnrolmentDto {
  @IsString()
  branchId!: string;

  @IsString()
  memberId!: string;

  @IsString()
  @MaxLength(190)
  externalUserId!: string;
}

export class ListDeviceEnrolmentsQueryDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  memberId?: string;
}
