import {
  IsInt,
  IsPositive,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateOnlinePaymentIntentDto {
  @IsInt()
  @IsPositive()
  amount: number; // amount in cents

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  memberId?: string; // to associate with a member

  @IsOptional()
  @IsString()
  @MaxLength(255)
  membershipId?: string; // to associate with a membership
}
