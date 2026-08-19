import { PartialType } from '@nestjs/mapped-types';
import { IsIn, IsOptional } from 'class-validator';
import { CreateMemberDto } from './create-member.dto';

export class UpdateMemberDto extends PartialType(CreateMemberDto) {
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'FROZEN', 'EXPIRED'])
  status?: 'ACTIVE' | 'INACTIVE' | 'FROZEN' | 'EXPIRED';
}
