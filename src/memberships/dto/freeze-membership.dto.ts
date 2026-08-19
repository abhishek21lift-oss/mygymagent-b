import { IsInt, IsPositive } from 'class-validator';

export class FreezeMembershipDto {
  @IsInt()
  @IsPositive()
  days!: number;
}
