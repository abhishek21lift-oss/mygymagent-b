import { IsIn, IsOptional, IsString } from 'class-validator';

export class LeadIdArgsDto {
  @IsString()
  leadId!: string;
}

export class CreateMemberFollowupArgsDto {
  @IsString()
  memberId!: string;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  dueAt?: string;

  @IsOptional()
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
}
