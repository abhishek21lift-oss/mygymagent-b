import { IsInt, IsPositive } from 'class-validator';

export class ExtendMembershipDto {
  @IsInt()
  @IsPositive()
  days!: number;
}
