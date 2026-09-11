import { IsOptional, IsString } from 'class-validator';

export class TransferMembershipDto {
  @IsString()
  memberId!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
