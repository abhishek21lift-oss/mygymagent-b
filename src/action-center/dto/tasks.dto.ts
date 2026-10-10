import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { TaskCategory, TaskPriority, TaskStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export const TASK_VIEWS = [
  'my',
  'today',
  'upcoming',
  'overdue',
  'completed',
  'team',
  'unassigned',
  'escalated',
  'ai',
] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export class ChecklistItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  text!: string;

  @IsBoolean()
  done!: boolean;
}

export class CreateTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsEnum(TaskCategory)
  category?: TaskCategory;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsDateString()
  dueAt!: string;

  @IsOptional()
  @IsUUID()
  memberId?: string;

  @IsOptional()
  @IsUUID()
  leadId?: string;

  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  checklist?: ChecklistItemDto[];
}

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsEnum(TaskCategory)
  category?: TaskCategory;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  /** Reschedule / snooze. */
  @IsOptional()
  @IsDateString()
  dueAt?: string;

  /** A user id, or null to unassign. */
  @IsOptional()
  @IsString()
  assignedToUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  completionNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelReason?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  checklist?: ChecklistItemDto[];
}

export class TaskCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}

export class EscalateTaskDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class ListTasksQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(TASK_VIEWS)
  view?: TaskView;

  /** The day "today" means: YYYY-MM-DD in the gym's timezone. */
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsEnum(TaskCategory)
  category?: TaskCategory;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  @IsOptional()
  @IsUUID()
  memberId?: string;

  @IsOptional()
  @IsUUID()
  leadId?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;
}
