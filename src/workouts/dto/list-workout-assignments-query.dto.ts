import { IsIn, IsOptional, IsString } from 'class-validator';
import type { WorkoutAssignmentStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

const STATUSES: WorkoutAssignmentStatus[] = ['ACTIVE', 'COMPLETED', 'CANCELLED'];

export class ListWorkoutAssignmentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: WorkoutAssignmentStatus;
}
