import { IsOptional, IsString } from 'class-validator';

export class CancelMembershipDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
