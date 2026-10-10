import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  CreateTaskDto,
  EscalateTaskDto,
  ListTasksQueryDto,
  TaskCommentDto,
  UpdateTaskDto,
} from './dto/tasks.dto';
import { TasksService } from './tasks.service';

/** The Action Center worklist. Tasks are never deleted: cancel instead. */
@Controller('tasks')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @RequirePermissions('tasks.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query() query: ListTasksQueryDto,
  ) {
    return this.tasks.list(user, branchScope, query);
  }

  @Get(':id')
  @RequirePermissions('tasks.read')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tasks.get(user, branchScope, id);
  }

  @Post()
  @RequirePermissions('tasks.work')
  @Audited({ resource: 'task', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Body() dto: CreateTaskDto,
  ) {
    return this.tasks.create(user, branchScope, dto);
  }

  @Patch(':id')
  @RequirePermissions('tasks.work')
  @Audited({ resource: 'task', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasks.update(user, branchScope, id, dto);
  }

  @Post(':id/comments')
  @RequirePermissions('tasks.work')
  comment(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TaskCommentDto,
  ) {
    return this.tasks.comment(user, branchScope, id, dto.body);
  }

  @Post(':id/escalate')
  @RequirePermissions('tasks.work')
  @Audited({ resource: 'task', action: 'escalate' })
  escalate(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EscalateTaskDto,
  ) {
    return this.tasks.escalate(user, branchScope, id, dto.reason);
  }
}
