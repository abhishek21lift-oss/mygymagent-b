import { IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

export class PauseMembershipDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  days?: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
