import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  SEGMENT_FIELDS,
  type SegmentOperator,
  type SegmentRule,
} from '../segment-rules';

const OPERATORS: SegmentOperator[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
];

const FIELD_NAMES = SEGMENT_FIELDS.map((field) => field.name);

/**
 * One clause of a segment definition.
 *
 * `field` is checked against the catalogue GET /members/segments/fields
 * publishes rather than accepted as free text: a rule naming a field the
 * evaluator does not know silently matches nobody, which reads to the
 * operator as "this segment is empty" rather than "this rule is wrong".
 */
export class SegmentRuleDto implements SegmentRule {
  @IsIn(FIELD_NAMES)
  field!: string;

  @IsIn(OPERATORS)
  operator!: SegmentOperator;

  // Deliberately untyped: a rule's value is a string, number, boolean or an
  // array of those depending on the field and operator, and the evaluator
  // coerces. Only its presence is enforced -- but it needs a decorator to
  // get that far, because whitelist + forbidNonWhitelisted rejects any
  // property class-validator has no rule for.
  @IsDefined()
  value!: string | number | boolean | string[] | number[];

  @IsOptional()
  @IsIn(['AND', 'OR'])
  logicalOp?: 'AND' | 'OR';
}

export class CreateSegmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsArray()
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => SegmentRuleDto)
  rules!: SegmentRuleDto[];
}

export class UpdateSegmentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => SegmentRuleDto)
  rules?: SegmentRuleDto[];
}

/**
 * Paging for a segment's members.
 *
 * The controller used to parseInt two raw query strings, so `?limit=abc`
 * reached Prisma as `take: NaN`. There is no enableImplicitConversion, so
 * @Type is what turns the query string into a number.
 */
export class SegmentMembersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
