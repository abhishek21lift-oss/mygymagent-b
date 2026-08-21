import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

const ASSESSMENT_TYPES = [
  'INITIAL',
  'PROGRESS',
  'PAR_Q',
  'FITNESS_TEST',
  'CUSTOM',
] as const;

export class CreateMemberAssessmentDto {
  @IsIn(ASSESSMENT_TYPES)
  type!: (typeof ASSESSMENT_TYPES)[number];

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  conductedAt?: string;
}
