import { IsIn } from 'class-validator';
import type { DietAssignmentStatus } from '@prisma/client';

const STATUSES: DietAssignmentStatus[] = ['ACTIVE', 'COMPLETED', 'CANCELLED'];

export class UpdateDietAssignmentStatusDto {
  @IsIn(STATUSES)
  status!: DietAssignmentStatus;
}
