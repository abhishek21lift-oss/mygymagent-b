import { IsDateString, IsOptional, IsString } from 'class-validator';

/** Shared shape for ASSIGN_WORKOUT_PLAN / ASSIGN_DIET_PLAN payloads --
 * identical fields to AssignWorkoutPlanDto/AssignDietPlanDto plus the
 * plan id itself (those DTOs get the plan id from the URL, not the
 * body; an AiAction has no URL, so it travels in the payload). Used to
 * re-validate `AiAction.payload` at approval time, not just when it was
 * first drafted -- the same "never trust stored JSON blindly" discipline
 * validateToolArgs applies to a live tool call. */
export class AssignPlanPayloadDto {
  @IsString()
  memberId!: string;

  @IsString()
  planId!: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
