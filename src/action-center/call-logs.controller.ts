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
import { CallLogsService } from './call-logs.service';
import {
  CreateCallLogDto,
  ListCallLogsQueryDto,
  UpdateCallLogDto,
} from './dto/call-logs.dto';

@Controller('call-logs')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class CallLogsController {
  constructor(private readonly calls: CallLogsService) {}

  /** History and search across call notes (tasks.read). */
  @Get()
  @RequirePermissions('tasks.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query() query: ListCallLogsQueryDto,
  ) {
    return this.calls.list(user, branchScope, query);
  }

  @Get(':id')
  @RequirePermissions('tasks.read')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.calls.get(user, branchScope, id);
  }

  @Post()
  @RequirePermissions('tasks.work')
  @Audited({ resource: 'call_log', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Body() dto: CreateCallLogDto,
  ) {
    return this.calls.create(user, branchScope, dto);
  }

  @Patch(':id')
  @RequirePermissions('tasks.work')
  @Audited({ resource: 'call_log', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCallLogDto,
  ) {
    return this.calls.update(user, branchScope, id, dto);
  }

  /** Run the AI analysis again (after a failure, or to refresh). */
  @Post(':id/analyze')
  @RequirePermissions('tasks.work')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  analyze(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.calls.retryAnalysis(user, branchScope, id);
  }
}
