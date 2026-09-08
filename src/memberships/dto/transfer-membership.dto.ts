import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class TransferMembershipDto {
  @IsUUID()
  toMemberId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
