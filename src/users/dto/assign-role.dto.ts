import { IsOptional, IsString } from 'class-validator';

export class AssignRoleDto {
  @IsString()
  roleKey!: string;

  @IsOptional()
  @IsString()
  branchId?: string;
}
