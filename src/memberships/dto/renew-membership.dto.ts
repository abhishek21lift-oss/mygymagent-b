import { IsNumber, IsOptional } from 'class-validator';

export class RenewMembershipDto {
  @IsOptional()
  @IsNumber()
  discount?: number;
}
