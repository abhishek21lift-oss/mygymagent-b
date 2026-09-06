import { IsOptional, IsString } from 'class-validator';

export class ConvertLeadDto {
  /** Required only if the lead has no branchId set. */
  @IsOptional()
  @IsString()
  branchId?: string;

  /** Optional trainer assignment copied onto the newly created member. */
  @IsOptional()
  @IsString()
  assignedTrainerId?: string;
}
