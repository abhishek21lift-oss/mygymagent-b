import { IsString, ValidateIf } from 'class-validator';

export class AssignTrainerDto {
  /** The trainer's user id, or null to leave the member without one. */
  @ValidateIf((dto: AssignTrainerDto) => dto.trainerId !== null)
  @IsString()
  trainerId!: string | null;
}
