import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpsertCommissionRuleDto {
  @IsString()
  trainerId!: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  percentage!: number;

  @IsOptional()
  @IsString()
  sessionType?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fixedAmount?: number;
}

export class GenerateCommissionsDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}
