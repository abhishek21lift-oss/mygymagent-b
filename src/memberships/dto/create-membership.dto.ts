import { IsBoolean, IsDateString, IsOptional, IsString } from 'class-validator';

export class CreateMembershipDto {
  @IsString()
  memberId!: string;

  @IsString()
  membershipPlanId!: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;
}
