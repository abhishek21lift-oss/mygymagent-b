import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateFoodItemDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  servingSize?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  calories?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  proteinG?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  carbsG?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fatG?: number;
}
