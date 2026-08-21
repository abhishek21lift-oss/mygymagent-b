import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

const MEAL_SLOTS = ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] as const;

export class DietPlanItemDto {
  @IsString()
  foodItemId!: string;

  @IsIn(MEAL_SLOTS)
  mealSlot!: (typeof MEAL_SLOTS)[number];

  @IsNumber()
  @Min(0)
  quantity!: number;

  @IsString()
  unit!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateDietPlanDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DietPlanItemDto)
  items!: DietPlanItemDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  targetCalories?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetProteinG?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetCarbsG?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetFatG?: number;
}
