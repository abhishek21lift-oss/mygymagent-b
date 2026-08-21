import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateMemberScreeningDto {
  @IsOptional()
  @IsString()
  assessmentId?: string;

  /// PAR-Q question-key -> boolean answer, e.g. { hasHeartCondition: false,
  /// chestPainDuringActivity: false, ... }. Kept as a plain object rather
  /// than a fixed DTO shape since the exact question set is a business/
  /// compliance decision, not something this API should hard-code.
  @IsObject()
  responses!: Record<string, boolean>;

  @IsBoolean()
  flaggedForMedicalClearance!: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}
