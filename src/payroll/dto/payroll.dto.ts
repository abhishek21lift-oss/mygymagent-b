import { OmitType, PartialType } from '@nestjs/mapped-types';
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

/**
 * An edit to an existing rule: the rate, the flat amount, or the session
 * type, validated like a new rule. The trainer is the rule's identity,
 * so it is not editable -- a rule for someone else is a new rule.
 */
export class UpdateCommissionRuleDto extends PartialType(
  OmitType(UpsertCommissionRuleDto, ['trainerId'] as const),
) {}

export class GenerateCommissionsDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}
