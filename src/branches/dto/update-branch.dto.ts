import { PartialType } from '@nestjs/mapped-types';
import { IsIn, IsOptional } from 'class-validator';
import { CreateBranchDto } from './create-branch.dto';

export class UpdateBranchDto extends PartialType(CreateBranchDto) {
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}
