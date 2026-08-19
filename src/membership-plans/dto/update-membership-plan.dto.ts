import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateMembershipPlanDto } from './create-membership-plan.dto';

export class UpdateMembershipPlanDto extends PartialType(
  CreateMembershipPlanDto,
) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
