import { IsIn } from 'class-validator';
import type { WorkoutAssignmentStatus } from '@prisma/client';

const STATUSES: WorkoutAssignmentStatus[] = [
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
];

export class UpdateWorkoutAssignmentStatusDto {
  @IsIn(STATUSES)
  status!: WorkoutAssignmentStatus;
}
